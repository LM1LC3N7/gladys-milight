// -----------------------------------------------------------------------------
// The link to one bridge: one UDP socket, one sender, one datagram every
// `gap` ms at most (the bridge drops orders sent faster).
//
// Jobs (the datagrams of one command) go out in their arrival order, except
// the protective ones ("off"), which pass in front of every other job, and
// cancel the jobs of their zone still waiting (or the rest of the one being
// sent): nothing queued before an "off" leaves after it. A non-protective job
// gives way to a protective one between two of its datagrams.
//
// v6: a session is asked when none is fresh (one request at a time, bounded);
// each order carries a sequence number, and its acknowledgement is matched by
// that number only, from the address and port of the bridge only. The sender
// never waits for an acknowledgement: the next datagram leaves after the gap,
// the acknowledgements are awaited aside, so a slow bridge never holds an
// "off" behind a command. A job whose acknowledgements are missing is sent
// once more, unless a newer job of its zone has left meanwhile.
//
// Legacy: the bridge never answers; "sent" is all there is to know.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { LIMITS, VERSIONS } from './constants.js';
import { SESSION_REQUEST, parseAck, parseSession, v6Frame } from './protocol.js';

/** A UDP socket bound to one bridge: what comes from elsewhere is dropped. */
export function openUdp({ host, port }) {
  const socket = dgram.createSocket('udp4');
  const listeners = new Set();
  let closed = false;
  socket.on('message', (msg, rinfo) => {
    if (rinfo.address !== host || rinfo.port !== port || msg.length > LIMITS.datagram) return;
    for (const fn of listeners) fn(msg);
  });
  socket.on('error', () => {
    // A send error is reported by its callback; the socket stays usable.
  });
  return {
    send(buf) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(Object.assign(new Error('closed'), { kind: 'closed' }));
          return;
        }
        socket.send(buf, port, host, (err) =>
          err ? reject(Object.assign(err, { kind: 'socket' })) : resolve(),
        );
      });
    },
    onMessage(fn) {
      listeners.add(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}

const failure = (kind, extra = {}) => Object.assign(new Error(kind), { kind, ...extra });

/** Resolves true as soon as one of the promises resolves true, false when all resolved otherwise. */
function anyTrue(list) {
  return new Promise((resolve) => {
    let left = list.length;
    if (left === 0) resolve(false);
    for (const p of list) {
      p.then((ok) => {
        left -= 1;
        if (ok) resolve(true);
        else if (left === 0) resolve(false);
      });
    }
  });
}

export class Link {
  /**
   * @param {{ bridge: { host: string, port: number, version: string }, open?: Function,
   *   timers: object, monotonic: () => number, timings: object,
   *   onSession?: (info: { mac: string }) => void, onContact?: (ok: boolean) => void }} options
   */
  constructor({ bridge, open = openUdp, timers, monotonic, timings, onSession, onContact }) {
    this.bridge = bridge;
    this.v6 = bridge.version === VERSIONS.V6;
    this.openSocket = open;
    this.timers = timers;
    this.monotonic = monotonic;
    this.timings = timings;
    this.onSession = onSession ?? (() => {});
    this.onContact = onContact ?? (() => {});
    this.socket = undefined;
    this.queue = [];
    this.running = false;
    this.closed = false;
    this.lastSendAt = -Infinity;
    /** zone -> id of the last job of which a datagram left. */
    this.lastSent = new Map();
    /** zone -> id of the last protective job arrived. */
    this.lastProtective = new Map();
    // v6
    this.session = undefined;
    this.mac = undefined;
    this.lastContact = -Infinity;
    this.sessionPromise = undefined;
    this.sessionWaiter = undefined;
    this.seq = 0;
    this.ackWaiters = new Map();
    /** Running waits: { handle, end }, ended at close. */
    this.waits = new Set();
  }

  socketOf() {
    if (!this.socket) {
      this.socket = this.openSocket({ host: this.bridge.host, port: this.bridge.port });
      this.socket.onMessage((msg) => this.message(msg));
    }
    return this.socket;
  }

  message(msg) {
    if (this.closed) return;
    const seq = parseAck(msg);
    if (seq !== undefined) {
      const waiter = this.ackWaiters.get(seq);
      if (waiter) {
        this.ackWaiters.delete(seq);
        this.lastContact = this.monotonic();
        waiter.resolve(true);
      }
      return;
    }
    const session = parseSession(msg);
    if (session && this.sessionWaiter) {
      const waiter = this.sessionWaiter;
      this.sessionWaiter = undefined;
      waiter(session);
    }
  }

  sleep(ms) {
    return this.within(new Promise(() => {}), ms, undefined);
  }

  /** Resolves with the value, or with `fallback` after `ms` or at close (the timer cleared either way). */
  within(promise, ms, fallback) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(fallback);
        return;
      }
      const wait = { handle: undefined, end: undefined };
      const finish = (value) => {
        if (!this.waits.delete(wait)) return;
        this.timers.clearTimeout(wait.handle);
        resolve(value);
      };
      wait.end = () => finish(fallback);
      wait.handle = this.timers.setTimeout(() => finish(fallback), Math.max(0, ms));
      this.waits.add(wait);
      promise.then(finish);
    });
  }

  /** A v6 session, asked again when not fresh. Rejects `noAnswer` / `socket` / `closed`. */
  ensureSession({ force = false } = {}) {
    const fresh = this.monotonic() - this.lastContact < this.timings.sessionFresh;
    if (this.session && fresh && !force) return Promise.resolve(this.session);
    if (!this.sessionPromise) {
      this.sessionPromise = this.askSession().finally(() => {
        this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  async askSession() {
    for (let i = 0; i < this.timings.sessionTries; i += 1) {
      if (this.closed) throw failure('closed');
      const answer = new Promise((resolve) => {
        this.sessionWaiter = resolve;
      });
      try {
        await this.socketOf().send(SESSION_REQUEST);
      } catch (err) {
        this.sessionWaiter = undefined;
        this.session = undefined;
        if (err.kind === 'closed' || this.closed) throw failure('closed');
        this.onContact(false);
        throw failure('socket');
      }
      const got = await this.within(answer, this.timings.sessionWait, undefined);
      this.sessionWaiter = undefined;
      if (this.closed) throw failure('closed');
      if (got) {
        this.session = got.session;
        this.mac = got.mac;
        this.lastContact = this.monotonic();
        this.onSession({ mac: got.mac });
        this.onContact(true);
        return got.session;
      }
    }
    this.session = undefined;
    this.onContact(false);
    throw failure('noAnswer');
  }

  /**
   * Queues the datagrams of one command. Resolves `{ sent, acked, total }`
   * (acked: every datagram acknowledged, v6 only) or rejects with a `kind`:
   * cancelled, late, full, refused, noAnswer, socket, closed (each with `sent`).
   * `guard()`, checked before each datagram of a non-protective job, may refuse it.
   */
  submit({ id, zone, packets, protective = false, deadline, startBy, guard }) {
    if (this.closed) return Promise.reject(failure('closed', { sent: 0 }));
    return new Promise((resolve, reject) => {
      const job = {
        id,
        zone,
        packets,
        protective,
        deadline,
        startBy,
        guard,
        next: 0,
        sent: 0,
        // Per datagram, the acknowledgement promises of each time it was sent.
        acks: packets.map(() => []),
        retried: false,
        resolve,
        reject,
        settled: false,
      };
      if (protective) {
        this.lastProtective.set(zone, Math.max(this.lastProtective.get(zone) ?? 0, id));
        // Older non-protective jobs of the zone still waiting: never sent after this one.
        for (const other of this.queue) {
          if (!other.protective && other.zone === zone && other.id < id) {
            this.fail(other, 'cancelled');
          }
        }
        this.queue = this.queue.filter((j) => !j.settled);
        const firstOther = this.queue.findIndex((j) => !j.protective);
        if (firstOther === -1) this.queue.push(job);
        else this.queue.splice(firstOther, 0, job);
      } else {
        if (this.queue.filter((j) => !j.protective).length >= LIMITS.queue) {
          this.fail(job, 'full');
          return;
        }
        this.queue.push(job);
      }
      this.pump();
    });
  }

  fail(job, kind) {
    if (job.settled) return;
    job.settled = true;
    job.reject(failure(kind, { sent: job.sent }));
  }

  succeed(job, acked) {
    if (job.settled) return;
    job.settled = true;
    job.resolve({ sent: job.sent, acked, total: job.packets.length });
  }

  /** True when a newer job of the zone left, or (non-protective) an "off" arrived after it. */
  overtaken(job) {
    return (
      (this.lastSent.get(job.zone) ?? 0) > job.id ||
      (!job.protective && (this.lastProtective.get(job.zone) ?? 0) > job.id)
    );
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        this.queue = this.queue.filter((j) => !j.settled);
        // The queue is kept in order at each insertion: protective jobs first.
        const job = this.queue[0];
        if (!job) break;
        await this.step(job);
      }
    } finally {
      this.running = false;
    }
  }

  /** Sends the next datagram of a job (after the gap), or ends it. */
  async step(job) {
    const now = this.monotonic();
    if (!job.protective && this.overtaken(job)) {
      this.drop(job);
      this.fail(job, 'cancelled');
      return;
    }
    if (job.sent === 0 && job.startBy !== undefined && now > job.startBy) {
      this.drop(job);
      this.fail(job, 'late');
      return;
    }
    const wait = this.lastSendAt + this.timings.gap - now;
    if (wait > 0) {
      await this.sleep(wait);
      return; // choose again: a protective job may have arrived
    }
    if (this.v6) {
      try {
        await this.ensureSession();
      } catch (err) {
        this.drop(job);
        this.fail(job, err.kind ?? 'noAnswer');
        return;
      }
      if (this.closed || job.settled) return;
      if (!job.protective && this.queue.some((j) => j.protective)) return;
    }
    // The identity of the bridge, checked right before each datagram (never for an "off").
    if (!job.protective && job.guard && !job.guard()) {
      this.drop(job);
      this.fail(job, 'refused');
      return;
    }
    const packet = job.packets[job.next];
    let ack;
    let buf;
    if (this.v6) {
      this.seq = (this.seq + 1) & 0xff;
      const seq = this.seq;
      this.ackWaiters.get(seq)?.resolve(false);
      ack = new Promise((resolve) => this.ackWaiters.set(seq, { resolve }));
      buf = v6Frame(this.session, seq, packet.v6, packet.zone);
    } else {
      buf = packet.legacy;
    }
    try {
      this.lastSendAt = this.monotonic();
      await this.socketOf().send(buf);
    } catch (err) {
      this.drop(job);
      this.fail(job, err.kind === 'closed' ? 'closed' : 'socket');
      return;
    }
    job.sent += 1;
    job.next += 1;
    this.lastSent.set(job.zone, Math.max(this.lastSent.get(job.zone) ?? 0, job.id));
    if (ack) job.acks[job.next - 1].push(ack);
    if (job.next < job.packets.length) return;
    this.drop(job);
    if (!this.v6) {
      this.succeed(job, false);
      return;
    }
    this.awaitAcks(job);
  }

  drop(job) {
    const i = this.queue.indexOf(job);
    if (i !== -1) this.queue.splice(i, 1);
  }

  /** v6: the acknowledgements of a job, aside from the sender (a late one of a first send counts). */
  async awaitAcks(job) {
    const all = () =>
      Promise.all(job.acks.map((list) => anyTrue(list))).then((list) => list.every(Boolean));
    const left = Math.min(this.timings.ackWait, job.deadline - this.monotonic());
    const acked = await this.within(all(), left, false);
    if (this.closed) {
      this.fail(job, 'closed');
      return;
    }
    if (acked) {
      this.succeed(job, true);
      return;
    }
    // A missing acknowledgement: the session may have expired, asked again next time.
    this.session = undefined;
    const time = job.deadline - this.monotonic();
    if (!job.retried && !job.protective && time > this.timings.ackWait && !this.overtaken(job)) {
      // Sent once more (the whole command, in order), unless a newer one left.
      job.retried = true;
      job.next = 0;
      const firstOther = this.queue.findIndex((j) => !j.protective);
      if (firstOther === -1) this.queue.push(job);
      else this.queue.splice(firstOther, 0, job);
      this.pump();
      return;
    }
    const last = await this.within(all(), Math.max(0, time), false);
    if (this.closed) {
      this.fail(job, 'closed');
      return;
    }
    this.succeed(job, last);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue) this.fail(job, 'closed');
    this.queue = [];
    for (const waiter of this.ackWaiters.values()) waiter.resolve(false);
    this.ackWaiters.clear();
    if (this.sessionWaiter) {
      const waiter = this.sessionWaiter;
      this.sessionWaiter = undefined;
      waiter(undefined);
    }
    for (const wait of [...this.waits]) wait.end();
    this.socket?.close();
  }
}
