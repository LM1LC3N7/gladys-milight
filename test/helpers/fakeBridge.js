// -----------------------------------------------------------------------------
// A simulated MiLight bridge on 127.0.0.1 (a real UDP socket, never the
// network). v6: answers the session request with its MAC address and a
// session id, acknowledges each order whose session id and checksum are right
// (like the real one, it ignores the others); legacy: records, never answers.
// Silence, latency, a changed MAC and a burst of lost answers on demand.
// Also: a sped-up real clock and `until`.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { SESSION_REQUEST } from '../../src/protocol.js';

export const MAC = 'ac:cf:23:f5:7a:d4';
const macBytes = (mac) => mac.split(':').map((h) => parseInt(h, 16));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPES = { 0x08: 'fullColor', 0x07: 'rgbw', 0x01: 'white', 0x00: 'bridgeLamp' };
const V6_ACTIONS = {
  fullColor: { '4,1': 'on', '4,2': 'off', 3: 'brightness', 1: 'hue', 2: 'saturation', 5: 'kelvin' },
  rgbw: { '3,1': 'on', '3,2': 'off', '3,5': 'white', 2: 'brightness', 1: 'hue' },
  white: { '1,7': 'on', '1,8': 'off' },
  bridgeLamp: { '3,3': 'on', '3,4': 'off', '3,5': 'white', 2: 'brightness', 1: 'hue' },
};
const LEGACY = new Map([
  ...[0x45, 0x47, 0x49, 0x4b].map((c, i) => [c, { lamp: `rgbw-${i + 1}`, action: 'on' }]),
  ...[0x46, 0x48, 0x4a, 0x4c].map((c, i) => [c, { lamp: `rgbw-${i + 1}`, action: 'off' }]),
  ...[0xc5, 0xc7, 0xc9, 0xcb].map((c, i) => [c, { lamp: `rgbw-${i + 1}`, action: 'white' }]),
  ...[0x38, 0x3d, 0x37, 0x32].map((c, i) => [c, { lamp: `white-${i + 1}`, action: 'on' }]),
  ...[0x3b, 0x33, 0x3a, 0x36].map((c, i) => [c, { lamp: `white-${i + 1}`, action: 'off' }]),
]);

/** What an order means: { lamp: 'rgbw-2', action: 'off', value }. */
export function decodeV6(buf) {
  const kind = TYPES[buf[13]];
  const zone = buf[19];
  const table = V6_ACTIONS[kind] ?? {};
  const action = table[`${buf[14]},${buf[15]}`] ?? table[buf[14]];
  const lamp =
    kind === 'bridgeLamp' ? 'bridgelamp' : `${kind === 'fullColor' ? 'fullcolor' : kind}-${zone}`;
  return { lamp, action, value: buf[15] };
}

export async function startBridge({ version = 'v6', mac = MAC, session = [0x05, 0x01] } = {}) {
  const socket = dgram.createSocket('udp4');
  const other = dgram.createSocket('udp4');
  const bridge = {
    version,
    mac,
    session,
    /** Every datagram: { at, bytes, type: session|order|legacy|bad, seq?, lamp?, action?, value? } */
    packets: [],
    /** Ms of the real clock before answering (a number or a function). */
    latency: 0,
    silent: false,
    ackSilent: false,
    /** Orders not acknowledged (the next n). */
    dropAcks: 0,
    /** Orders whose acknowledgement is lost: (order) => boolean. */
    dropAck: undefined,
    /** Acknowledgements with a wrong sequence number. */
    wrongSeq: false,
    /** Answers sent from another socket (another port of the same host). */
    spoof: false,
    port: 0,
    socket,
    orders(filter = {}) {
      return this.packets.filter(
        (p) =>
          (p.type === 'order' || p.type === 'legacy') &&
          Object.entries(filter).every(([k, v]) => p[k] === v),
      );
    },
    sessions() {
      return this.packets.filter((p) => p.type === 'session');
    },
    async halt() {
      await new Promise((resolve) => {
        try {
          other.close();
          socket.close(resolve);
        } catch {
          resolve();
        }
      });
    },
  };
  const answer = async (buf, rinfo) => {
    const latency = typeof bridge.latency === 'function' ? bridge.latency() : bridge.latency;
    if (latency > 0) await sleep(latency);
    if (bridge.silent) return;
    try {
      (bridge.spoof ? other : socket).send(buf, rinfo.port, rinfo.address);
    } catch {
      // closed
    }
  };
  socket.on('message', (msg, rinfo) => {
    const at = performance.now();
    if (bridge.version === 'legacy') {
      const known = msg.length === 3 && msg[2] === 0x55 ? LEGACY.get(msg[0]) : undefined;
      const extra =
        msg[0] === 0x4e
          ? { action: 'brightness', value: msg[1] }
          : msg[0] === 0x40
            ? { action: 'hue', value: msg[1] }
            : {};
      bridge.packets.push({ at, bytes: [...msg], type: 'legacy', ...known, ...extra });
      return;
    }
    if (msg.equals(SESSION_REQUEST)) {
      bridge.packets.push({ at, bytes: [...msg], type: 'session' });
      const out = Buffer.from([
        0x28,
        0x00,
        0x00,
        0x00,
        0x11,
        0x00,
        0x02,
        ...macBytes(bridge.mac),
        0x69,
        0xf0,
        0x3c,
        0x23,
        0x00,
        0x01,
        bridge.session[0],
        bridge.session[1],
        0x00,
      ]);
      answer(out, rinfo);
      return;
    }
    const sum = [...msg.subarray(10, 21)].reduce((s, b) => s + b, 0) & 0xff;
    const valid =
      msg.length === 22 &&
      msg[0] === 0x80 &&
      msg[4] === 0x11 &&
      msg[5] === bridge.session[0] &&
      msg[6] === bridge.session[1] &&
      msg[10] === 0x31 &&
      msg[21] === sum;
    if (!valid) {
      bridge.packets.push({ at, bytes: [...msg], type: 'bad' });
      return;
    }
    const seq = msg[8];
    bridge.packets.push({ at, bytes: [...msg], type: 'order', seq, ...decodeV6(msg) });
    if (bridge.ackSilent || bridge.dropAck?.(bridge.packets.at(-1))) return;
    if (bridge.dropAcks > 0) {
      bridge.dropAcks -= 1;
      return;
    }
    const acked = bridge.wrongSeq ? (seq + 1) & 0xff : seq;
    answer(Buffer.from([0x88, 0x00, 0x00, 0x00, 0x03, 0x00, acked, 0x00]), rinfo);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  await new Promise((resolve) => other.bind(0, '127.0.0.1', resolve));
  bridge.port = socket.address().port;
  return bridge;
}

/** A sped-up real clock: timers divided by `speed`, monotonic and wall in simulated ms. */
export function speedClock(speed = 10) {
  let drift = 0;
  const origin = performance.now();
  let set = 0;
  const live = new Set();
  const timers = {
    setTimeout: (fn, ms) => {
      set += 1;
      const handle = setTimeout(
        () => {
          live.delete(handle);
          fn();
        },
        Math.max(0, Number(ms) || 0) / speed,
      );
      live.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      live.delete(handle);
      clearTimeout(handle);
    },
  };
  return {
    speed,
    timers,
    get set() {
      return set;
    },
    get live() {
      return live.size;
    },
    monotonic: () => (performance.now() - origin) * speed + 1_000_000 + (drift += 0.001),
    now: () => 1_800_000_000_000 + (performance.now() - origin) * speed,
    /** Waits `ms` of the sped-up clock. */
    wait: (ms) => sleep(ms / speed),
  };
}

export const until = async (check, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(2);
  }
};
