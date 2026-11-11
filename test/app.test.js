// -----------------------------------------------------------------------------
// MilightApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a simulated bridge on 127.0.0.1 (real UDP) and a sped-up
// REAL clock (it moves between any two reads), a memory store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MilightApp } from '../src/app.js';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { MAC, speedClock, startBridge, until } from './helpers/fakeBridge.js';

const SPEED = 10;
const id = (lamp, key) => `ext:milight:lamp:${lamp}${key ? `:${key}` : ''}`;
const quietLogger = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );

async function setup(
  t,
  {
    bridge,
    version = 'v6',
    store = memoryStore(),
    config = {},
    speed = SPEED,
    connect = true,
    port,
    getConfig,
  } = {},
) {
  if (!bridge && port === undefined) bridge = await startBridge({ version });
  const gladys = createFakeGladys({
    selector: 'milight',
    config: {
      bridge_address: `127.0.0.1:${port ?? bridge.port}`,
      bridge_version: version,
      full_color_zones: version === 'v6' ? ['1'] : [],
      rgbw_zones: ['1', '2', '3', '4'],
      white_zones: ['2'],
      language: 'en',
      ...config,
    },
  });
  if (getConfig) {
    // The fake reads the configuration itself in connect(): only the app's reads fail.
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = () => (gladys.connected ? getConfig() : original());
  }
  const logs = [];
  const clock = speedClock(speed);
  const app = new MilightApp({
    gladys,
    logger: quietLogger(logs),
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, quietLogger(logs));
  t.after(async () => {
    await app.stop();
    await bridge?.halt();
  });
  if (connect) {
    await gladys.connect();
    await until(() => app.configRead || app.configError, 3000, 'config');
    await until(() => app.memory !== undefined || app.storeFailed, 3000, 'store');
  }
  return { gladys, app, bridge, logs, store, clock };
}

/** The last badge published for a lamp. */
const badge = (gladys, lamp) =>
  gladys.fake.transports.findLast((b) => b.device_external_id === id(lamp));

const set = (gladys, lamp, key, value) =>
  gladys.fake.setValue({ external_id: id(lamp) }, { external_id: id(lamp, key) }, value);

test('Discovery: the ticked zones as lights, badges "assumed state", status after the first answer', async (t) => {
  const { gladys, bridge } = await setup(t);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [
    id('fullcolor-1'),
    id('rgbw-1'),
    id('rgbw-2'),
    id('rgbw-3'),
    id('rgbw-4'),
    id('white-2'),
  ]);
  const badges = gladys.fake.transports;
  assert.equal(badges.length, 6);
  assert.ok(badges.every((b) => b.degraded === true && /Assumed state/.test(b.message.en)));
  assert.match(gladys.fake.connectionStatus.message.en, /not checked/);
  assert.equal(bridge.sessions().length, 0, 'nothing read at the start before 5 min');
  const ack = await set(gladys, 'rgbw-2', 'binary', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    bridge.orders().map((o) => `${o.lamp} ${o.action}`),
    ['rgbw-2 on'],
  );
  await until(
    () =>
      gladys.fake.connectionStatus.connected === true &&
      /answered/.test(gladys.fake.connectionStatus.message.en),
  );
  assert.match(gladys.fake.connectionStatus.message.en, new RegExp(MAC));
});

test('brightness, colour, temperature: on first, then the value; "on" published as assumed', async (t) => {
  // A slower clock: the gaps are measured at the bridge, where a loaded machine adds its jitter.
  const speed = 2;
  const { gladys, bridge } = await setup(t, { speed });
  assert.equal((await set(gladys, 'rgbw-1', 'brightness', 40)).success, true);
  assert.equal((await set(gladys, 'fullcolor-1', 'temperature', 370)).success, true);
  assert.equal((await set(gladys, 'fullcolor-1', 'color', 0x00ff00)).success, true);
  assert.deepEqual(
    bridge.orders().map((o) => `${o.lamp} ${o.action}`),
    [
      'rgbw-1 on',
      'rgbw-1 brightness',
      'fullcolor-1 on',
      'fullcolor-1 kelvin',
      'fullcolor-1 on',
      'fullcolor-1 hue',
      'fullcolor-1 saturation',
    ],
  );
  assert.equal(bridge.orders({ action: 'brightness' })[0].value, 40);
  assert.equal(bridge.orders({ action: 'kelvin' })[0].value, 0);
  assert.equal(gladys.fake.lastState(id('rgbw-1', 'binary')), 1);
  // One datagram every 100 ms at most (measured at the bridge: 1 ms of delivery jitter is 2 ms here).
  const at = bridge.orders().map((o) => o.at * speed);
  for (let i = 1; i < at.length; i += 1)
    assert.ok(at[i] - at[i - 1] >= 75, `gap ${at[i] - at[i - 1]}`);
});

test('refusals: invalid value, unknown lamp, zone not ticked, kind not on this bridge: nothing sent', async (t) => {
  const { gladys, bridge } = await setup(t, { config: { rgbw_zones: ['1'] } });
  for (const [lamp, key, value, error] of [
    ['rgbw-1', 'brightness', 0, /Invalid value/],
    ['rgbw-1', 'binary', '', /Invalid value/],
    ['rgbw-1', 'binary', null, /Invalid value/],
    ['rgbw-1', 'color', 'red', /Invalid value/],
    ['rgbw-3', 'binary', 1, /not ticked/],
    ['white-2', 'brightness', 50, /not a MiLight lamp/],
  ]) {
    const ack = await set(gladys, lamp, key, value);
    assert.equal(ack.success, false, `${lamp} ${key}`);
    assert.match(ack.error, error);
    assert.doesNotMatch(ack.error, /red/, 'the value typed is never shown back');
  }
  assert.equal(bridge.packets.length, 0);
});

test('off: three sends spaced, the first acknowledgement answers at once', async (t) => {
  const speed = 4;
  const { gladys, bridge, clock } = await setup(t, { speed });
  const started = performance.now();
  const ack = await set(gladys, 'rgbw-3', 'binary', 0);
  assert.equal(ack.success, true, ack.error);
  assert.ok((performance.now() - started) * speed < 1500, 'answered at the first acknowledgement');
  await until(() => bridge.orders({ lamp: 'rgbw-3', action: 'off' }).length === 3);
  const at = bridge.orders({ action: 'off' }).map((o) => o.at * speed);
  assert.ok(at[1] - at[0] >= 400 && at[2] - at[0] >= 1350, `${at.map((x) => x - at[0])}`);
  await clock.wait(2500);
  assert.equal(bridge.orders({ action: 'off' }).length, 3, 'bounded: three sends');
});

test('off passes in front and cancels the waiting commands of its lamp: nothing older leaves after it', async (t) => {
  const { gladys, bridge } = await setup(t);
  const others = [];
  for (let i = 1; i <= 8; i += 1) others.push(set(gladys, 'rgbw-1', 'brightness', 10 * i));
  others.push(set(gladys, 'rgbw-2', 'binary', 1));
  await until(() => bridge.orders().length >= 1);
  const off = await set(gladys, 'rgbw-1', 'binary', 0);
  assert.equal(off.success, true, off.error);
  const acks = await Promise.all(others);
  assert.ok(
    acks.some((a) => !a.success && /Cancelled/i.test(a.error)),
    'older ones cancelled',
  );
  assert.ok(acks.at(-1).success, 'another lamp is not cancelled');
  await until(() => bridge.orders({ lamp: 'rgbw-1', action: 'off' }).length === 3);
  const list = bridge.orders({ lamp: 'rgbw-1' });
  const firstOff = list.findIndex((o) => o.action === 'off');
  assert.ok(
    list.slice(firstOff).every((o) => o.action === 'off'),
    list.map((o) => o.action).join(','),
  );
});

test('a newer command that LEFT cancels the resends of the off; one only queued does not', async (t) => {
  const { gladys, bridge, clock } = await setup(t, { speed: 2 });
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 0)).success, true);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  await clock.wait(2500);
  const list = bridge.orders({ lamp: 'rgbw-1' }).map((o) => o.action);
  assert.equal(list.at(-1), 'on', `no off sent after the newer on: ${list}`);
  assert.equal(list.filter((a) => a === 'off').length, 1);
});

test('off not acknowledged: failure that says so, held in /data, sent again every 30 s; confirmed later -> state off', async (t) => {
  const store = memoryStore();
  const { gladys, bridge, app, clock } = await setup(t, { store });
  bridge.ackSilent = true;
  const ack = await set(gladys, 'rgbw-4', 'binary', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not acknowledged.*every 30 s/);
  assert.ok(Object.hasOwn(store.data.held, 'rgbw-4'), 'kept in /data');
  await until(() => /not confirmed/.test(badge(gladys, 'rgbw-4')?.message.en));
  const sends = bridge.orders({ action: 'off' }).length;
  assert.ok(sends >= 3);
  bridge.ackSilent = false;
  await clock.wait(TIMINGS.heldRetry + 2000);
  await until(() => !app.held.has('rgbw-4'), 3000, 'held released');
  assert.equal(gladys.fake.lastState(id('rgbw-4', 'binary')), 0);
  assert.equal(store.data.held['rgbw-4'], undefined);
});

test('held off dropped when a newer command of the lamp leaves', async (t) => {
  const { gladys, bridge, app, clock } = await setup(t);
  bridge.ackSilent = true;
  assert.equal((await set(gladys, 'rgbw-4', 'binary', 0)).success, false);
  bridge.ackSilent = false;
  assert.equal((await set(gladys, 'rgbw-4', 'binary', 1)).success, true);
  assert.equal(app.held.has('rgbw-4'), false);
  const before = bridge.orders({ action: 'off' }).length;
  await clock.wait(TIMINGS.heldRetry + 3000);
  assert.equal(bridge.orders({ action: 'off' }).length, before, 'no off over the newer on');
});

test('the off leaves after a restart from /data, before the configuration is read', async (t) => {
  const bridge = await startBridge();
  const clock = speedClock(SPEED);
  const store = memoryStore({
    bridge: { host: '127.0.0.1', port: bridge.port, version: 'v6' },
    mac: MAC,
    held: { 'rgbw-2': clock.now() - 60_000 },
  });
  let reads = 0;
  const { gladys, app } = await setup(t, {
    bridge,
    store,
    getConfig: async () => {
      reads += 1;
      throw new Error('host API down');
    },
  });
  await until(
    () => bridge.orders({ lamp: 'rgbw-2', action: 'off' }).length >= 1,
    2000 / SPEED + 1000,
    'off sent at once',
  );
  await until(() => !app.held.has('rgbw-2'), 3000, 'confirmed');
  assert.ok(reads >= 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  // A click on "off" still goes, through the bridge kept in /data.
  const ack = await set(gladys, 'rgbw-1', 'binary', 0);
  assert.equal(ack.success, true, ack.error);
  // The others need the configuration.
  const on = await set(gladys, 'rgbw-1', 'binary', 1);
  assert.match(on.error, /Configuration not read/);
});

test('getConfig() failing in "connected": tried again, spaced, until it reads; then all normal', async (t) => {
  const bridge = await startBridge();
  let fails = 2;
  const config = {
    bridge_address: `127.0.0.1:${bridge.port}`,
    rgbw_zones: ['1'],
    language: 'en',
  };
  const times = [];
  const { gladys, app, clock } = await setup(t, {
    bridge,
    connect: false,
    getConfig: async () => {
      times.push(clock.monotonic());
      if (fails > 0) {
        fails -= 1;
        throw new Error('503');
      }
      return config;
    },
  });
  await gladys.connect();
  await until(() => app.configRead, 4000, 'config read');
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 4500, 'spaced 5 s');
  assert.ok(times[2] - times[1] >= 9000, 'then 10 s');
  assert.ok(
    gladys.fake.connectionStatuses.some((s) => /tried again in 5 s/.test(s.message?.en ?? '')),
  );
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
});

test('/data unreadable: no pin learnt, only off sent; read again every 10 s, then normal', async (t) => {
  const store = memoryStore({ mac: '11:22:33:44:55:66' });
  store.unreadable = true;
  const { gladys, bridge, app, clock } = await setup(t, { store });
  assert.equal(app.memory, undefined);
  const on = await set(gladys, 'rgbw-1', 'binary', 1);
  assert.match(on.error, /Storage \/data not read/);
  const off = await set(gladys, 'rgbw-1', 'binary', 0);
  assert.equal(off.success, true, off.error);
  assert.match(gladys.fake.connectionStatus.message.en, /cannot be read/);
  const loads = store.loads;
  await clock.wait(TIMINGS.storeRetry + 1500);
  assert.ok(store.loads > loads && store.loads <= loads + 2, 'read again, one at a time');
  assert.equal(store.data.mac, '11:22:33:44:55:66', 'never written over');
  store.unreadable = false;
  await until(() => app.memory !== undefined, 15_000 / SPEED + 2000, 'read');
  // The pin was another bridge: refused, the off still goes.
  const again = await set(gladys, 'rgbw-1', 'binary', 1);
  assert.match(again.error, /Another bridge/);
  assert.equal(bridge.orders({ action: 'on' }).length, 0);
});

test('another bridge at the address: off only, status says it; "Test" twice accepts it (saved first)', async (t) => {
  const store = memoryStore({ mac: '11:22:33:44:55:66' });
  const { gladys, bridge, clock } = await setup(t, { store });
  const on = await set(gladys, 'rgbw-1', 'binary', 1);
  assert.equal(on.success, false);
  assert.match(on.error, /Another bridge/);
  assert.equal(bridge.orders({ action: 'on' }).length, 0, 'checked before the datagram');
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 0)).success, true, 'off still goes');
  await until(() => gladys.fake.connectionStatus.connected === false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Another bridge answers.*11:22:33:44:55:66/,
  );
  const first = await gladys.fake.action('test_bridge', {});
  assert.match(
    first.message?.en ?? first.result?.en ?? JSON.stringify(first),
    /Press again within 2 min/,
  );
  await clock.wait(TIMINGS.testSpacing + 500);
  store.unwritable = true;
  const unsaved = await gladys.fake.action('test_bridge', {});
  assert.match(JSON.stringify(unsaved), /could not be saved/);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, false, 'still refused');
  store.unwritable = false;
  await clock.wait(TIMINGS.testSpacing + 500);
  const second = await gladys.fake.action('test_bridge', {});
  assert.match(JSON.stringify(second), /accepted/);
  assert.equal(store.data.mac, MAC);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
});

test('Test button: spaced 5 s, never faster', async (t) => {
  const { gladys, bridge } = await setup(t);
  await gladys.fake.action('test_bridge', {});
  const again = await gladys.fake.action('test_bridge', {});
  assert.match(JSON.stringify(again), /try again in/);
  assert.equal(bridge.sessions().length, 1);
});

test('bridge silent: commands "nothing sent", status and badges unreachable; off held and said', async (t) => {
  const { gladys, bridge, app } = await setup(t);
  bridge.silent = true;
  const on = await set(gladys, 'rgbw-1', 'binary', 1);
  assert.match(on.error, /does not answer \(nothing sent\)/);
  await until(() => gladys.fake.connectionStatus.connected === false);
  await until(() => badge(gladys, 'rgbw-2')?.transport === 'unreachable');
  const off = await set(gladys, 'rgbw-1', 'binary', 0);
  assert.equal(off.success, false);
  assert.match(off.error, /not sent: tried again/);
  assert.ok(app.held.has('rgbw-1'));
});

test('lost acknowledgement of a command: sent again once; late one counts; never an older one after a newer', async (t) => {
  const { gladys, bridge } = await setup(t);
  await set(gladys, 'rgbw-1', 'binary', 1);
  bridge.dropAcks = 2;
  const ack = await set(gladys, 'rgbw-1', 'brightness', 30);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.orders({ action: 'brightness' }).length, 2, 'sent once more');
  bridge.ackSilent = true;
  const slow = set(gladys, 'rgbw-1', 'brightness', 50);
  await until(() => bridge.orders({ action: 'brightness' }).length === 3);
  bridge.ackSilent = false;
  const newer = await set(gladys, 'rgbw-1', 'brightness', 90);
  assert.equal(newer.success, true);
  const older = await slow;
  assert.equal(older.success, false);
  const values = bridge.orders({ action: 'brightness' }).map((o) => o.value);
  assert.equal(values.at(-1), 90, `the newer value stays last: ${values}`);
});

test('scene: five lamps at once on a slow bridge (500-900 ms) are all set', async (t) => {
  const { gladys, bridge } = await setup(t);
  await set(gladys, 'rgbw-1', 'binary', 1);
  bridge.latency = () => (500 + Math.random() * 400) / SPEED;
  const acks = await Promise.all([
    set(gladys, 'rgbw-1', 'binary', 0),
    set(gladys, 'rgbw-2', 'binary', 0),
    set(gladys, 'rgbw-3', 'binary', 0),
    set(gladys, 'rgbw-4', 'binary', 0),
    set(gladys, 'fullcolor-1', 'binary', 0),
  ]);
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true, true, true, true],
    JSON.stringify(acks),
  );
});

test('queue full: refused, nothing sent; the off still goes in front', async (t) => {
  const speed = 2;
  const { gladys, bridge } = await setup(t, { speed });
  bridge.latency = 5;
  const many = [];
  for (let i = 0; i < LIMITS.queue + 5; i += 1)
    many.push(set(gladys, 'rgbw-2', 'brightness', 1 + (i % 99)));
  const off = set(gladys, 'rgbw-3', 'binary', 0);
  const clicked = performance.now();
  const times = many.map((p) => p.then(() => (performance.now() - clicked) * speed));
  const acks = await Promise.all(many);
  assert.ok(acks.some((a) => /Too many commands/.test(a.error ?? '')));
  assert.ok(acks.some((a) => /queue was busy/.test(a.error ?? '')));
  const slowest = Math.max(...(await Promise.all(times)));
  assert.ok(slowest < 4000, `every command answered before Gladys gives up: ${slowest}`);
  assert.equal((await off).success, true);
  const firstOff = bridge.orders().findIndex((o) => o.action === 'off');
  assert.ok(firstOff <= 4, `off sent at datagram ${firstOff}`);
});

test('legacy bridge: bytes of the developer page, success without answer, off three times', async (t) => {
  const { gladys, bridge } = await setup(t, { version: 'legacy' });
  assert.match(gladys.fake.connectionStatus.message.en, /Legacy bridge/);
  assert.equal((await set(gladys, 'rgbw-2', 'brightness', 100)).success, true);
  assert.equal((await set(gladys, 'white-2', 'binary', 1)).success, true);
  assert.equal((await set(gladys, 'rgbw-2', 'binary', 0)).success, true);
  await until(() => bridge.orders({ lamp: 'rgbw-2', action: 'off' }).length === 3);
  assert.deepEqual(
    bridge.packets.slice(0, 4).map((p) => p.bytes.map((b) => b.toString(16)).join(' ')),
    ['47 0 55', '4e 1b 55', '3d 0 55', '48 0 55'],
  );
  const test = await gladys.fake.action('test_bridge', {});
  assert.match(JSON.stringify(test), /never answers/);
  assert.ok(
    gladys.fake.discoveredDevices.every((d) => !/fullcolor|bridgelamp/.test(d.external_id)),
  );
});

test('periodic check of a v6 bridge: never sooner than 5 min after the last one, even after a restart', async (t) => {
  const speed = 30;
  const clock = speedClock(speed);
  const before = clock.now() - 4 * 60_000;
  const store = memoryStore({ lastCheckAt: before });
  const { bridge, app } = await setup(t, { store, speed });
  const started = performance.now();
  assert.equal(bridge.sessions().length, 0);
  await until(() => bridge.sessions().length === 1, 60_000 / speed + 5000, 'check after 1 min');
  const after = (performance.now() - started) * speed;
  assert.ok(
    after >= 45_000,
    `checked ${Math.round(after)} ms after the start, not sooner than 1 min`,
  );
  assert.ok(store.data.lastCheckAt > before + 60_000, 'written with the check');
  await until(() => app.contact === true, 2000, 'answered');
});

test('stop: nothing sent and no timer left after it', async (t) => {
  const { gladys, bridge, app, clock } = await setup(t);
  bridge.ackSilent = true;
  await set(gladys, 'rgbw-1', 'binary', 0);
  await app.stop();
  const count = bridge.packets.length;
  await clock.wait(TIMINGS.heldRetry + 2000);
  assert.equal(bridge.packets.length, count);
  assert.equal(clock.live, 0, 'no timer left');
});

test('reconnection: nothing read, no state republished; config saved unchanged keeps the link', async (t) => {
  const { gladys, app, bridge } = await setup(t);
  await set(gladys, 'rgbw-1', 'binary', 1);
  const link = app.link;
  const states = gladys.fake.states.length;
  await gladys.fake.configUpdated({ ...gladys.fake.config });
  assert.equal(app.link, link);
  gladys.emit?.('connected');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gladys.fake.states.length, states);
  assert.equal(bridge.sessions().length, 1);
});

test('acknowledgements: only the right sequence number, only from the bridge address and port', async (t) => {
  const { gladys, bridge } = await setup(t);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  bridge.wrongSeq = true;
  const wrong = await set(gladys, 'rgbw-1', 'brightness', 20);
  assert.match(wrong.error, /did not acknowledge/);
  bridge.wrongSeq = false;
  bridge.spoof = true;
  const spoofed = await set(gladys, 'rgbw-1', 'brightness', 30);
  assert.equal(spoofed.success, false, 'an answer from another port is not the bridge');
});

test('v6 session: asked again after 30 s idle, and when the bridge restarted with a new id', async (t) => {
  const { gladys, bridge, clock } = await setup(t);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  assert.equal(bridge.sessions().length, 1);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  assert.equal(bridge.sessions().length, 1, 'a fresh session is kept');
  await clock.wait(TIMINGS.sessionFresh + 1000);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  assert.equal(bridge.sessions().length, 2, 'asked again after 30 s');
  bridge.session = [0x09, 0x09];
  const ack = await set(gladys, 'rgbw-1', 'brightness', 60);
  assert.equal(ack.success, true, ack.error);
  assert.equal(bridge.sessions().length, 3, 'renewed after a missing acknowledgement');
});

test('held off: given up 10 min after the click, said on the badge, no more sends', async (t) => {
  const speed = 200;
  const { gladys, bridge, app, clock } = await setup(t, { speed });
  bridge.ackSilent = true;
  assert.equal((await set(gladys, 'rgbw-3', 'binary', 0)).success, false);
  await until(() => !app.held.has('rgbw-3'), (TIMINGS.heldFor + 60_000) / speed + 2000, 'given up');
  await until(() => /never confirmed/.test(badge(gladys, 'rgbw-3')?.message.en));
  const sends = bridge.orders({ action: 'off' }).length;
  assert.ok(sends >= 3 * 19 && sends <= 3 * 22, `${sends} sends in 10 min`);
  await clock.wait(2 * TIMINGS.heldRetry);
  assert.equal(bridge.orders({ action: 'off' }).length, sends);
});

test('a newer off takes over: the older one, unconfirmed, holds nothing', async (t) => {
  const { gladys, bridge, app, clock } = await setup(t);
  assert.equal((await set(gladys, 'rgbw-1', 'binary', 1)).success, true);
  bridge.ackSilent = true;
  const older = set(gladys, 'rgbw-1', 'binary', 0);
  await until(() => bridge.orders({ action: 'off' }).length === 1);
  bridge.ackSilent = false;
  const newer = await set(gladys, 'rgbw-1', 'binary', 0);
  assert.equal(newer.success, true, newer.error);
  assert.equal((await older).success, false);
  await clock.wait(500);
  assert.equal(app.held.has('rgbw-1'), false, 'no stale hold');
  assert.doesNotMatch(badge(gladys, 'rgbw-1').message.en, /not confirmed/);
});
