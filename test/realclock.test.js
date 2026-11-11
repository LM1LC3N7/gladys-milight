// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, time
// sped up) and a real local UDP socket playing the bridge: the held "off" is
// really sent again every 30 s and the v6 bridge really checked every 5 min,
// never sooner, never a cycle late; a click on "off" in between leaves at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MilightApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { speedClock, startBridge, until } from './helpers/fakeBridge.js';

/** Records the times (sped-up clock) at which a method of the app is called. */
function spyOn(object, method, clock) {
  const original = object[method].bind(object);
  const spy = { calls: [] };
  object[method] = (...args) => {
    spy.calls.push(clock.monotonic());
    return original(...args);
  };
  return spy;
}

/** Waits for `count` calls; their gaps must be within 0.9..1.5 x the period (late under load, never early). */
async function measurePeriod(spy, { count, period, speed }) {
  await until(
    () => spy.calls.length >= count,
    ((count + 1) * period * 1.5) / speed + 2000,
    'calls',
  );
  const gaps = spy.calls.slice(1, count).map((t, i) => Math.round(t - spy.calls[i]));
  for (const gap of gaps) {
    assert.ok(gap >= 0.9 * period && gap <= 1.5 * period, `gaps ${gaps} for ${period}`);
  }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function start(t, speed, store = memoryStore(), clock = speedClock(speed)) {
  const bridge = await startBridge();
  const gladys = createFakeGladys({
    selector: 'milight',
    config: { bridge_address: `127.0.0.1:${bridge.port}`, rgbw_zones: ['1', '2'] },
  });
  const app = new MilightApp({
    gladys,
    logger: quiet,
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(async () => {
    await app.stop();
    await bridge.halt();
  });
  return { bridge, clock, gladys, app };
}

test('real clock: a held "off" is sent again every 30 s', async (t) => {
  const { bridge, clock, gladys, app } = await start(t, 50);
  const spy = spyOn(app, 'retryHeld', clock);
  registerHandlers(gladys, app, quiet);
  await gladys.connect();
  bridge.ackSilent = true;
  const ack = await gladys.fake.setValue(
    { external_id: 'ext:milight:lamp:rgbw-1' },
    { external_id: 'ext:milight:lamp:rgbw-1:binary' },
    0,
  );
  assert.equal(ack.success, false);
  await measurePeriod(spy, { count: 3, period: TIMINGS.heldRetry, speed: 50 });
  // A click on another lamp in between leaves at once (within 1 s of the sped-up clock).
  const clicked = performance.now();
  const off = gladys.fake.setValue(
    { external_id: 'ext:milight:lamp:rgbw-2' },
    { external_id: 'ext:milight:lamp:rgbw-2:binary' },
    0,
  );
  await until(() => bridge.orders({ lamp: 'rgbw-2', action: 'off' }).length > 0, 2000);
  const delay = (bridge.orders({ lamp: 'rgbw-2', action: 'off' })[0].at - clicked) * 50;
  assert.ok(delay < 1000, `off sent ${Math.round(delay)} ms after the click`);
  await off;
});

test('real clock: the v6 bridge is checked every 5 min, the first one 5 min after the last of /data', async (t) => {
  const clock = speedClock(300);
  const store = memoryStore({ lastCheckAt: clock.now() - 2 * 60_000 });
  const { bridge, gladys, app } = await start(t, 300, store, clock);
  const spy = spyOn(app, 'check', clock);
  registerHandlers(gladys, app, quiet);
  const started = clock.monotonic();
  await gladys.connect();
  await measurePeriod(spy, { count: 3, period: TIMINGS.checkInterval, speed: 300 });
  // The first check 3 min after the start (5 min after the one of /data), never sooner.
  assert.ok(spy.calls[0] - started >= 0.9 * 3 * 60_000, `first at ${spy.calls[0] - started}`);
  assert.ok(spy.calls[0] - started <= 1.5 * 3 * 60_000, `first at ${spy.calls[0] - started}`);
  assert.ok(bridge.sessions().length >= 2 && bridge.sessions().length <= 4);
});
