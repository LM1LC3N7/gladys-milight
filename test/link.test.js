// -----------------------------------------------------------------------------
// The Link alone, on a scripted socket (no network): cases the simulated
// bridge cannot stage, such as an "off" refused by the network while an
// older command waits for its acknowledgement.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../src/link.js';
import { SESSION_REQUEST, packetsFor } from '../src/protocol.js';
import { until } from './helpers/fakeBridge.js';

const TIMINGS = {
  gap: 10,
  ackWait: 60,
  sessionWait: 50,
  sessionTries: 2,
  sessionFresh: 60_000,
};

const SESSION_ANSWER = Buffer.from([
  0x28, 0, 0, 0, 0x11, 0, 0x02, 0xac, 0xcf, 0x23, 0xf5, 0x7a, 0xd4, 0x69, 0xf0, 0x3c, 0x23, 0, 1,
  0x05, 0x01, 0,
]);

function scriptedSocket({ refuse = () => false } = {}) {
  const sent = [];
  let deliver;
  return {
    sent,
    open() {
      return {
        async send(buf) {
          if (refuse(buf)) throw Object.assign(new Error('EHOSTUNREACH'), { kind: 'socket' });
          sent.push({ at: performance.now(), buf: Buffer.from(buf) });
          if (buf.equals(SESSION_REQUEST)) setTimeout(() => deliver(SESSION_ANSWER), 1);
        },
        onMessage(fn) {
          deliver = fn;
        },
        close() {},
      };
    },
  };
}

const isOff = (buf) =>
  buf.length === 22 && buf[13] === 0x07 && buf[14] === 0x03 && buf[15] === 0x02;

test('an older command is never sent again after an "off" was clicked, even one the network refused', async (t) => {
  const socket = scriptedSocket({ refuse: isOff });
  const link = new Link({
    bridge: { host: '10.0.0.2', port: 5987, version: 'v6' },
    open: socket.open,
    timers: globalThis,
    monotonic: () => performance.now(),
    timings: TIMINGS,
  });
  t.after(() => link.close());
  const zone = 'rgbw-1';
  const older = link.submit({
    id: 1,
    zone,
    packets: packetsFor('v6', 'rgbw', 1, 'brightness', 40),
    deadline: performance.now() + 2000,
  });
  await until(() => socket.sent.length === 3, 1000, 'session and two orders');
  const off = link.submit({
    id: 2,
    zone,
    packets: packetsFor('v6', 'rgbw', 1, 'off'),
    protective: true,
    deadline: performance.now() + 2000,
  });
  await assert.rejects(off, (err) => err.kind === 'socket');
  const result = await older;
  assert.equal(result.acked, false);
  assert.equal(socket.sent.length, 3, 'the brightness was not sent again after the off');
});

test('close: every wait ends, nothing left pending', async () => {
  const socket = scriptedSocket();
  const link = new Link({
    bridge: { host: '10.0.0.2', port: 5987, version: 'v6' },
    open: socket.open,
    timers: globalThis,
    monotonic: () => performance.now(),
    timings: { ...TIMINGS, ackWait: 60_000 },
  });
  const job = link.submit({
    id: 1,
    zone: 'rgbw-1',
    packets: packetsFor('v6', 'rgbw', 1, 'on'),
    deadline: performance.now() + 120_000,
  });
  await until(() => socket.sent.length === 2, 1000, 'sent');
  link.close();
  await assert.rejects(job, (err) => err.kind === 'closed');
  assert.equal(link.waits.size, 0);
  await assert.rejects(
    link.submit({ id: 2, zone: 'rgbw-1', packets: [] }),
    (e) => e.kind === 'closed',
  );
});

test('an "off" answers the waiting commands of its lamp "cancelled" at once, before its first datagram', async (t) => {
  const socket = scriptedSocket();
  const link = new Link({
    bridge: { host: '10.0.0.2', port: 8899, version: 'legacy' },
    open: socket.open,
    timers: globalThis,
    monotonic: () => performance.now(),
    timings: { ...TIMINGS, gap: 200 },
  });
  t.after(() => link.close());
  const busy = link.submit({
    id: 1,
    zone: 'rgbw-2',
    packets: packetsFor('legacy', 'rgbw', 2, 'brightness', 50),
  });
  const waiting = link.submit({
    id: 2,
    zone: 'rgbw-1',
    packets: packetsFor('legacy', 'rgbw', 1, 'on'),
  });
  await until(() => socket.sent.length === 1, 1000, 'first datagram');
  const off = link.submit({
    id: 3,
    zone: 'rgbw-1',
    packets: packetsFor('legacy', 'rgbw', 1, 'off'),
    protective: true,
  });
  let sentAtCancel;
  await assert.rejects(
    waiting.catch((err) => {
      sentAtCancel = socket.sent.length;
      throw err;
    }),
    (err) => err.kind === 'cancelled' && err.sent === 0,
  );
  assert.equal(sentAtCancel, 1, 'answered before the off left');
  assert.equal(
    link.queue.filter((j) => j.zone === 'rgbw-1' && !j.protective).length,
    0,
    'place freed',
  );
  await off;
  await busy;
});
