// -----------------------------------------------------------------------------
// The bytes of the protocol, checked against the examples of the LimitlessLED
// developer page, and the pure helpers (config, devices, /data).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddress, zonesOf } from '../src/config.js';
import { KINDS, TIMINGS } from '../src/constants.js';
import { buildLamp, lampOf, parseExternalId, valueOf } from '../src/devices.js';
import {
  SESSION_REQUEST,
  kelvinByte,
  legacyBrightness,
  legacyHue,
  packetsFor,
  parseAck,
  parseSession,
  rgbToHsv,
  v6Frame,
  v6Hue,
} from '../src/protocol.js';
import { fileStore, memoryStore, normalizeMemory } from '../src/store.js';

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

test('v6 framing: the RGB+CCT zone 1 "on" of the developer page, checksum 0x3F', () => {
  const [on] = packetsFor('v6', KINDS.FULL_COLOR, 1, 'on');
  const frame = v6Frame([0xab, 0xcd], 0x07, on.v6, on.zone);
  assert.equal(hex(frame), '80 00 00 00 11 ab cd 00 07 00 31 00 00 08 04 01 00 00 00 01 00 3f');
  assert.equal(SESSION_REQUEST.length, 27);
  assert.equal(SESSION_REQUEST[0], 0x20);
  assert.equal(SESSION_REQUEST.at(-1), 0x1e);
  assert.throws(() => v6Frame([0, 0], 1, [0x31, 0], 1));
});

test('v6 answers: session (MAC, id) and acknowledgement, anything else refused', () => {
  const answer = Buffer.from(
    '28 00 00 00 11 00 02 ac cf 23 f5 7a d4 69 f0 3c 23 00 01 05 00 00'
      .split(' ')
      .map((h) => parseInt(h, 16)),
  );
  assert.deepEqual(parseSession(answer), { mac: 'ac:cf:23:f5:7a:d4', session: [0x05, 0x00] });
  assert.equal(parseSession(answer.subarray(0, 21)), undefined, 'cut');
  assert.equal(parseSession(Buffer.concat([answer, Buffer.from([0])])), undefined, 'too long');
  const zeroMac = Buffer.from(answer);
  zeroMac.fill(0, 7, 13);
  assert.equal(parseSession(zeroMac), undefined);
  assert.equal(parseAck(Buffer.from([0x88, 0, 0, 0, 0x03, 0, 0x2a, 0])), 0x2a);
  assert.equal(parseAck(Buffer.from([0x88, 0, 0, 0, 0x03, 0, 0x2a, 1])), undefined);
  assert.equal(parseAck(Buffer.from([0x88, 0, 0, 0, 0x03, 0, 0x2a])), undefined);
  assert.equal(parseAck(answer), undefined);
  assert.equal(parseAck('88'), undefined);
});

test('legacy codes: RGBW and dual white zones, 3 bytes ending 0x55', () => {
  const bytes = (p) => hex(p.legacy);
  assert.deepEqual(packetsFor('legacy', KINDS.RGBW, 1, 'on').map(bytes), ['45 00 55']);
  assert.deepEqual(packetsFor('legacy', KINDS.RGBW, 4, 'off').map(bytes), ['4c 00 55']);
  assert.deepEqual(packetsFor('legacy', KINDS.WHITE, 2, 'on').map(bytes), ['3d 00 55']);
  assert.deepEqual(packetsFor('legacy', KINDS.WHITE, 4, 'off').map(bytes), ['36 00 55']);
  assert.deepEqual(packetsFor('legacy', KINDS.RGBW, 2, 'brightness', 100).map(bytes), [
    '47 00 55',
    '4e 1b 55',
  ]);
  assert.deepEqual(packetsFor('legacy', KINDS.RGBW, 3, 'color', 0xffffff).map(bytes), [
    '49 00 55',
    'c9 00 55',
  ]);
  assert.deepEqual(packetsFor('legacy', KINDS.RGBW, 1, 'color', 0xff0000).map(bytes), [
    '45 00 55',
    '40 b0 55',
  ]);
  assert.equal(legacyBrightness(1), 0x02);
  assert.equal(legacyBrightness(100), 0x1b);
  assert.equal(packetsFor('legacy', KINDS.WHITE, 1, 'brightness', 50), undefined);
  assert.equal(packetsFor('legacy', KINDS.FULL_COLOR, 1, 'on'), undefined);
  assert.equal(packetsFor('legacy', KINDS.BRIDGE_LAMP, 0, 'off'), undefined);
  assert.equal(packetsFor('legacy', KINDS.RGBW, 1, 'temperature', 200), undefined);
});

test('v6 orders by kind: off codes, brightness, colour, temperature', () => {
  const orders = (kind, zone, action, value) =>
    packetsFor('v6', kind, zone, action, value).map((p) => hex(p.v6.slice(3, 6)) + ` z${p.zone}`);
  assert.deepEqual(orders(KINDS.FULL_COLOR, 2, 'off'), ['08 04 02 z2']);
  assert.deepEqual(orders(KINDS.RGBW, 3, 'off'), ['07 03 02 z3']);
  assert.deepEqual(orders(KINDS.WHITE, 4, 'off'), ['01 01 08 z4']);
  assert.deepEqual(orders(KINDS.BRIDGE_LAMP, 0, 'off'), ['00 03 04 z1']);
  assert.deepEqual(orders(KINDS.RGBW, 1, 'brightness', 42), ['07 03 01 z1', '07 02 2a z1']);
  assert.deepEqual(orders(KINDS.FULL_COLOR, 1, 'temperature', 153), ['08 04 01 z1', '08 05 64 z1']);
  assert.deepEqual(orders(KINDS.FULL_COLOR, 1, 'temperature', 370), ['08 04 01 z1', '08 05 00 z1']);
  assert.deepEqual(orders(KINDS.RGBW, 1, 'color', 0xf0f0f0), ['07 03 01 z1', '07 03 05 z1']);
  assert.equal(orders(KINDS.FULL_COLOR, 1, 'color', 0xff0000).length, 3, 'hue and saturation');
  assert.equal(packetsFor('v6', KINDS.WHITE, 1, 'brightness', 10), undefined);
  assert.equal(packetsFor('v6', KINDS.RGBW, 1, 'temperature', 200), undefined);
  assert.equal(packetsFor('v6', 'other', 1, 'on'), undefined);
});

test('colours: HSV, the legacy wheel (0xB0 red) and the v6 shifts', () => {
  assert.deepEqual(rgbToHsv(0xff0000), { h: 0, s: 1, v: 1 });
  assert.equal(Math.round(rgbToHsv(0x00ff00).h), 120);
  assert.equal(Math.round(rgbToHsv(0x0000ff).h), 240);
  assert.equal(rgbToHsv(0).s, 0);
  assert.equal(legacyHue(0), 0xb0);
  assert.ok(legacyHue(60) > 0x80 && legacyHue(60) < 0x90, 'yellow near 0x80');
  assert.equal(v6Hue(KINDS.RGBW, 0), 0x18);
  assert.equal(v6Hue(KINDS.FULL_COLOR, 0), 0x07);
  assert.equal(v6Hue(KINDS.BRIDGE_LAMP, 0), 0xfd);
  assert.equal(kelvinByte(1e6 / 4600), 50);
  assert.equal(kelvinByte(10), 100, 'bounded');
  assert.equal(kelvinByte(10_000), 0, 'bounded');
});

test('address: IPv4 of the bridge only, never a broadcast, multicast or "any"; never echoed', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), {
    address: { host: '192.168.1.50', port: undefined },
  });
  assert.deepEqual(parseAddress(' http://192.168.1.50:9000/x '), {
    address: { host: '192.168.1.50', port: 9000 },
  });
  for (const bad of [
    '192.168.1.255',
    '255.255.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '239.1.2.3',
    '10.0.0.0',
  ]) {
    assert.deepEqual(parseAddress(bad), { broadcast: true }, bad);
  }
  for (const bad of [
    'bridge.local',
    '192.168.1',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    'a b',
    'u@1.2.3.4',
    '1.2.3\r\n.4',
  ]) {
    assert.deepEqual(parseAddress(bad), { invalid: true }, bad);
  }
  assert.deepEqual(parseAddress(''), {});
  const c = normalizeConfig({ bridge_address: '192.168.1.50', bridge_version: 'legacy' });
  assert.deepEqual(c.bridge, { host: '192.168.1.50', port: 8899, version: 'legacy' });
  assert.equal(normalizeConfig({ bridge_address: '192.168.1.50' }).bridge.port, 5987);
});

test('zones: 1..4 only, kinds that the bridge cannot drive are skipped and said', () => {
  assert.deepEqual(zonesOf(['3', '1', '1', 4, '5', '0', 'x', null, '1.0']), [1, 3, 4]);
  assert.deepEqual(zonesOf('1,2'), []);
  const legacy = normalizeConfig({
    bridge_address: '10.0.0.2',
    bridge_version: 'legacy',
    full_color_zones: ['1'],
    rgbw_zones: ['2'],
    white_zones: ['3'],
    bridge_lamp: true,
  });
  assert.deepEqual(legacy.lamps, [
    { kind: KINDS.RGBW, zone: 2 },
    { kind: KINDS.WHITE, zone: 3 },
  ]);
  assert.deepEqual(legacy.skipped, [KINDS.FULL_COLOR, KINDS.BRIDGE_LAMP]);
  const v6 = normalizeConfig({
    bridge_address: '10.0.0.2',
    full_color_zones: ['1'],
    bridge_lamp: 'true',
  });
  assert.deepEqual(v6.lamps, [{ kind: KINDS.FULL_COLOR, zone: 1 }], 'a string is not true');
});

test('devices: frozen ids, exact parsing, strict values', () => {
  const gladys = createFakeGladys({ selector: 'milight' });
  const device = buildLamp(gladys, { kind: KINDS.RGBW, zone: 2 }, { language: 'en' });
  assert.equal(device.external_id, 'ext:milight:lamp:rgbw-2');
  assert.equal(device.name, 'MiLight RGBW - zone 2');
  assert.deepEqual(
    device.features.map((f) => f.external_id),
    ['binary', 'brightness', 'color'].map((k) => `ext:milight:lamp:rgbw-2:${k}`),
  );
  assert.equal(
    buildLamp(gladys, { kind: KINDS.BRIDGE_LAMP, zone: 0 }).external_id,
    'ext:milight:lamp:bridgelamp',
  );
  assert.deepEqual(parseExternalId(gladys, 'ext:milight:lamp:fullcolor-4:temperature'), {
    kind: KINDS.FULL_COLOR,
    zone: 4,
    key: 'temperature',
  });
  for (const bad of [
    'ext:milight:lamp:white-1:brightness',
    'ext:milight:lamp:rgbw-5:binary',
    'ext:milight:lamp:rgbw-1:binary:x',
    'ext:other:lamp:rgbw-1:binary',
    'ext:milight:lamp:constructor-1:binary',
    'ext:milight:lamp:__proto__:binary',
    42,
  ]) {
    assert.equal(parseExternalId(gladys, bad), undefined, String(bad));
  }
  assert.equal(lampOf('toString-1'), undefined);
  assert.equal(valueOf('binary', 1), 1);
  assert.equal(valueOf('binary', '0'), 0);
  for (const bad of ['', null, true, undefined, 0.5, 2, 'on', NaN]) {
    assert.equal(valueOf('binary', bad), undefined, String(bad));
  }
  assert.equal(valueOf('brightness', 0), undefined, '0 is not off on a MiLight');
  assert.equal(valueOf('brightness', 100.4), undefined);
  assert.equal(valueOf('brightness', 55.4), 55);
  assert.equal(valueOf('color', 0xffffff + 1), undefined);
  assert.equal(valueOf('color', 12.5), undefined);
  assert.equal(valueOf('temperature', 152), undefined);
});

test('/data: future times invalid, old held offs dropped, bad values ignored', () => {
  const now = 1_800_000_000_000;
  const memory = normalizeMemory(
    {
      bridge: { host: '10.0.0.2', port: 5987, version: 'v6' },
      mac: 'AC:CF:23:F5:7A:D4',
      held: {
        'rgbw-1': now - 1000,
        'rgbw-2': now + 1000,
        'rgbw-3': now - TIMINGS.heldFor - 1,
        'evil-1': now - 1000,
        __proto__: now,
      },
      lastCheckAt: now + 5,
    },
    now,
    TIMINGS.heldFor,
  );
  assert.deepEqual(memory.held, { 'rgbw-1': now - 1000 });
  assert.equal(memory.mac, undefined, 'MAC in lower case only');
  assert.equal(memory.lastCheckAt, 0, 'a time in the future is invalid');
  assert.deepEqual(memory.bridge, { host: '10.0.0.2', port: 5987, version: 'v6' });
  assert.equal(
    normalizeMemory({ bridge: { host: 'x', port: 1, version: 'v6' } }, now, 1).bridge,
    undefined,
  );
  assert.deepEqual(normalizeMemory('garbage', now, 1).held, {});
});

test('/data file: missing is empty, unreadable is not; written 0600 in one piece', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'milight-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { ok: true, data: null });
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { ok: true, data: { a: 1 } });
  await writeFile(path, '{"a":');
  assert.deepEqual(await store.load(), { ok: false });
  await writeFile(path, 'x'.repeat(20_000));
  assert.deepEqual(await store.load(), { ok: false }, 'oversized');
  await writeFile(path, '{}');
  if (process.getuid?.() !== 0) {
    await chmod(path, 0o000);
    assert.deepEqual(await store.load(), { ok: false }, 'unreadable');
  }
  const mem = memoryStore();
  mem.unwritable = true;
  await assert.rejects(mem.save({}));
});
