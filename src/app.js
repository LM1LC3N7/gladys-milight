// -----------------------------------------------------------------------------
// The integration: one MiLight / LimitlessLED Wi-Fi bridge (its address and
// family in the configuration), the zones of lamps ticked by the user as
// Gladys lights, the badges, the "Test the bridge" button and the commands.
// index.js only wires the SDK handlers to it.
//
// MiLight bulbs never say their state: no state is ever read. Gladys saves the
// value of each command that succeeds (features `has_feedback: false`) and the
// badge of each lamp says the state is assumed. A v6 bridge acknowledges each
// datagram (the bridge got it, not the bulb); a legacy bridge says nothing.
//
// "Off" is the protective command. It depends on no option, no configuration
// read (the address of the bridge is also kept in /data), no /data read, no
// identity check, no queue bound: it passes in front of every other command
// and cancels those of its lamp still waiting. It is sent three times (at
// once, then 0.5 s and 1.5 s later), each resend dropped only when a newer
// command of the lamp has LEFT meanwhile. Not acknowledged (v6) or not sent at
// all, it is held: kept in /data, tried again every 30 s for 10 min after the
// click (a restart included), dropped when a newer command of the lamp leaves.
//
// The other commands (on, brightness, colour, temperature) need the
// configuration read, the zone ticked and, on a v6 bridge, /data read and the
// MAC address of the answering bridge equal to the pinned one. They are
// answered within 3.4 s (Gladys stops waiting at 5 s): success when sent
// (legacy) or acknowledged (v6), else a failure that says whether something
// left.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { bridgeKey, normalizeConfig } from './config.js';
import { FEATURES, LIMITS, TIMINGS, VERSIONS } from './constants.js';
import { buildLamp, lampId, lampIds, lampOf, parseExternalId, valueOf } from './devices.js';
import { ERRORS, T, join } from './i18n.js';
import { Link, openUdp } from './link.js';
import { packetsFor } from './protocol.js';
import { fileStore, normalizeMemory } from './store.js';

const commandError = (message, extra = {}) => Object.assign(new Error(message), extra);

export class MilightApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'milight' }),
    store = fileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    open = openUdp,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.open = open;
    this.timings = timings;
    this.config = normalizeConfig();
    this.configRead = false;
    this.configTimer = undefined;
    this.configDelay = timings.configRetryMin;
    this.configError = undefined;
    this.generation = 0;
    this.stopped = false;
    /** undefined: not read yet; then the normalized memory. */
    this.memory = undefined;
    this.storeFailed = false;
    this.storeUnwritable = false;
    this.loading = undefined;
    this.storeTimer = undefined;
    this.link = undefined;
    this.linkKey = '';
    /** Commands numbered at their arrival. */
    this.seq = 0;
    /** lamp id -> { id, until (monotonic), timer } of an "off" held. */
    this.held = new Map();
    /** lamp ids whose "off" was given up. */
    this.lost = new Set();
    /** lamp id -> number of the last "off" clicked. */
    this.lastOff = new Map();
    /** lamp id -> resend timers of the last "off". */
    this.resends = new Map();
    /** v6: true/false after an exchange, undefined before. */
    this.contact = undefined;
    /** v6: the MAC address of the bridge last answering. */
    this.seenMac = undefined;
    this.acceptPending = undefined;
    this.lastTestAt = -Infinity;
    this.checkTimer = undefined;
    this.nextCheckAt = undefined;
    /** Monotonic end of the last check: a contact after it (a command) postpones the next. */
    this.checkDoneAt = -Infinity;
    this.stateTimes = [];
    this.lastStatus = '';
    this.lastBadges = '';
  }

  // --- lifecycle --------------------------------------------------------------

  /** After every connection to Gladys: storage, configuration, Discovery, badges, status. */
  async connected(getConfig) {
    this.stopped = false;
    this.lastStatus = '';
    this.lastBadges = '';
    if (this.memory === undefined) this.loadMemory();
    this.clearConfigTimer();
    this.configDelay = this.timings.configRetryMin;
    await this.readConfig(getConfig);
  }

  async readConfig(getConfig) {
    const generation = this.generation;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (this.stopped || generation !== this.generation) return;
      this.logger.warn(`Configuration not read: ${err?.message ?? err}`);
      const delay = this.configDelay;
      this.configDelay = Math.min(this.timings.configRetryMax, delay * 2);
      this.configError = T.configUnread(delay);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (!this.stopped) this.readConfig(getConfig);
      }, delay);
      await this.publishStatus();
      await this.publishBadges();
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    this.configError = undefined;
    await this.applyConfig(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
  }

  async configUpdated(raw) {
    this.clearConfigTimer();
    this.configError = undefined;
    await this.applyConfig(raw);
  }

  async applyConfig(raw) {
    this.generation += 1;
    this.config = normalizeConfig(raw);
    this.configRead = true;
    const bridge = this.config.bridge;
    if (bridge) {
      this.useBridge(bridge);
      if (this.memory && bridgeKey(this.memory.bridge) !== bridgeKey(bridge)) {
        this.memory.bridge = { ...bridge };
        this.saveMemory();
      }
    }
    await this.publishDiscovery();
    await this.publishBadges();
    await this.publishStatus();
    this.scheduleCheck();
  }

  /** The link to a bridge (a new one when the address or the family changes). */
  useBridge(bridge) {
    const key = bridgeKey(bridge);
    if (this.link && this.linkKey === key) return this.link;
    this.link?.close();
    this.contact = undefined;
    this.seenMac = undefined;
    this.acceptPending = undefined;
    this.linkKey = key;
    this.link = new Link({
      bridge,
      open: this.open,
      timers: this.timers,
      monotonic: this.monotonic,
      timings: this.timings,
      onSession: ({ mac }) => this.sessionSeen(mac),
      onContact: (ok) => this.contactSeen(ok),
    });
    return this.link;
  }

  /** The bridge an "off" goes to: the configured one, else the one kept in /data. */
  offBridge() {
    return this.config.bridge ?? this.memory?.bridge;
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.clearConfigTimer();
    for (const handle of [this.storeTimer, this.checkTimer]) {
      if (handle !== undefined) this.timers.clearTimeout(handle);
    }
    this.storeTimer = undefined;
    this.checkTimer = undefined;
    for (const list of this.resends.values()) {
      for (const handle of list) this.timers.clearTimeout(handle);
    }
    this.resends.clear();
    for (const entry of this.held.values()) {
      if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.link?.close();
    this.link = undefined;
    this.linkKey = '';
    if (this.memory) await this.saveMemory();
  }

  // --- /data ------------------------------------------------------------------

  /** One read at a time; unreadable: read again every 10 s, never taken as empty. */
  loadMemory() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const result = await this.store.load().catch(() => ({ ok: false }));
      this.loading = undefined;
      if (this.stopped) return;
      if (!result.ok) {
        this.storeFailed = true;
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = undefined;
          if (!this.stopped) this.loadMemory();
        }, this.timings.storeRetry);
        await this.publishStatus();
        return;
      }
      this.storeFailed = false;
      this.memory = normalizeMemory(result.data, this.now(), this.timings.heldFor);
      if (this.config.bridge && bridgeKey(this.memory.bridge) !== bridgeKey(this.config.bridge)) {
        this.memory.bridge = { ...this.config.bridge };
        this.saveMemory();
      }
      if (this.seenMac && !this.memory.mac) this.pin(this.seenMac);
      // Offs held before the restart leave at once, before the configuration is read.
      const wall = this.now();
      for (const [id, at] of Object.entries(this.memory.held)) {
        if (!this.held.has(id)) {
          this.hold(id, this.seq, this.timings.heldFor - (wall - at), { at, now: true });
        }
      }
      this.scheduleCheck();
      await this.publishStatus();
      await this.publishBadges();
    })();
    return this.loading;
  }

  async saveMemory() {
    if (!this.memory) return false;
    try {
      await this.store.save(this.memory);
      if (this.storeUnwritable) {
        this.storeUnwritable = false;
        await this.publishStatus();
      }
      return true;
    } catch (err) {
      this.logger.warn(`/data not written: ${err?.message ?? err}`);
      if (!this.storeUnwritable) {
        this.storeUnwritable = true;
        await this.publishStatus();
      }
      return false;
    }
  }

  // --- identity (v6) ------------------------------------------------------------

  sessionSeen(mac) {
    this.seenMac = mac;
    if (this.memory && !this.memory.mac) this.pin(mac);
    if (this.memory?.mac && this.memory.mac !== mac) {
      this.logger.warn(`Another bridge answers at the address: ${mac} (pinned ${this.memory.mac})`);
    }
  }

  pin(mac) {
    this.memory.mac = mac;
    this.saveMemory();
  }

  contactSeen(ok) {
    if (this.contact === ok) {
      this.publishStatus();
      return;
    }
    this.contact = ok;
    this.publishStatus();
    this.publishBadges();
  }

  /** Whether a non-protective command may go to the bridge answering now (checked before each datagram). */
  identityOk() {
    if (this.config.bridge?.version !== VERSIONS.V6) return true;
    if (!this.memory) return false;
    return !this.memory.mac || !this.seenMac || this.memory.mac === this.seenMac;
  }

  // --- periodic check (v6) -------------------------------------------------------

  scheduleCheck() {
    if (this.checkTimer !== undefined) this.timers.clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    if (this.stopped || this.config.bridge?.version !== VERSIONS.V6) return;
    const mono = this.monotonic();
    if (this.nextCheckAt === undefined) {
      // After a restart: never sooner than 5 min after the last check (/data).
      const last = this.memory?.lastCheckAt ?? 0;
      const since = this.now() - last;
      this.nextCheckAt = mono + Math.max(0, this.timings.checkInterval - since);
    }
    this.checkTimer = this.timers.setTimeout(
      () => {
        this.checkTimer = undefined;
        this.check();
      },
      Math.max(0, this.nextCheckAt - mono),
    );
  }

  async check() {
    const link = this.link;
    if (this.stopped || !link || this.config.bridge?.version !== VERSIONS.V6) return;
    const mono = this.monotonic();
    const quiet = mono - link.lastContact;
    if (link.lastContact > this.checkDoneAt && quiet < this.timings.checkInterval) {
      // A command talked to the bridge meanwhile: nothing to check yet.
      this.nextCheckAt = link.lastContact + this.timings.checkInterval;
      this.scheduleCheck();
      return;
    }
    this.nextCheckAt = mono + this.timings.checkInterval;
    if (this.memory) {
      this.memory.lastCheckAt = this.now();
      await this.saveMemory();
    }
    if (this.stopped || link !== this.link) return;
    this.scheduleCheck();
    try {
      await link.ensureSession({ force: true });
    } catch {
      // contactSeen(false) already said it
    }
    this.checkDoneAt = this.monotonic();
  }

  // --- publications ------------------------------------------------------------

  async publishDiscovery() {
    const devices = this.config.lamps.map((lamp) =>
      buildLamp(this.gladys, lamp, { language: this.config.language }),
    );
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Discovery not published: ${err?.message ?? err}`);
    }
  }

  statusNow() {
    const c = this.config;
    if (this.configError) return [false, this.configError];
    if (!this.configRead) return [false, T.configUnread(0)];
    if (!c.bridge)
      return [false, c.invalid ? T.invalidAddress : c.broadcast ? T.broadcastAddress : T.noAddress];
    const notes = [
      c.lamps.length === 0 ? T.noLamps : undefined,
      c.skipped.length > 0 ? T.skipped : undefined,
      this.storeFailed && c.bridge.version === VERSIONS.V6 ? T.storeUnread : undefined,
      this.storeUnwritable ? T.storeUnwritable : undefined,
    ];
    if (c.bridge.version === VERSIONS.LEGACY) return [true, join(T.legacyOk(c.bridge), ...notes)];
    const pinned = this.memory?.mac;
    if (pinned && this.seenMac && pinned !== this.seenMac) {
      return [false, join(T.otherBridge(this.seenMac, pinned), ...notes)];
    }
    if (this.contact === false) return [false, join(T.v6NoAnswer(c.bridge), ...notes)];
    if (this.contact === true) return [true, join(T.v6Ok(this.seenMac), ...notes)];
    return [true, join(T.v6Unknown, ...notes)];
  }

  async publishStatus() {
    if (this.stopped) return;
    const [ok, message] = this.statusNow();
    const key = JSON.stringify([ok, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(ok, message);
    } catch (err) {
      this.lastStatus = '';
      this.logger.warn(`Status not published: ${err?.message ?? err}`);
    }
  }

  async publishBadges() {
    if (this.stopped) return;
    const ids = new Set(this.config.lamps.map(lampId));
    for (const id of [...this.held.keys(), ...this.lost]) ids.add(id);
    const transport = this.contact === false ? 'unreachable' : 'local';
    const entries = [...ids].slice(0, 100).map((id) => ({
      external_id: lampIds(this.gladys, lampOf(id)).device,
      transport,
      degraded: true,
      message: this.held.has(id) ? T.held : this.lost.has(id) ? T.lost : T.assumed,
    }));
    const key = JSON.stringify(entries);
    if (entries.length === 0 || key === this.lastBadges) return;
    this.lastBadges = key;
    try {
      await this.gladys.publishTransports(entries);
    } catch (err) {
      this.lastBadges = '';
      this.logger.warn(`Badges not published: ${err?.message ?? err}`);
    }
  }

  /** An assumed state (the command just sent), within 250 states a minute. */
  async publishAssumed(lamp, key, value) {
    const mono = this.monotonic();
    this.stateTimes = this.stateTimes.filter((t) => mono - t < 60_000);
    if (this.stateTimes.length >= LIMITS.statesPerMinute) return;
    this.stateTimes.push(mono);
    try {
      await this.gladys.publishState(lampIds(this.gladys, lamp).feature(key), value);
    } catch (err) {
      this.logger.warn(`State not published: ${err?.message ?? err}`);
    }
  }

  async scan() {
    await this.publishDiscovery();
    await this.publishBadges();
  }

  async devicesChanged() {
    this.lastBadges = '';
    await this.publishBadges();
  }

  // --- commands ---------------------------------------------------------------

  async setValue(device, feature, value) {
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || target.key === undefined) throw commandError(ERRORS.unknown);
    const lamp = { kind: target.kind, zone: target.zone };
    const checked = valueOf(target.key, value);
    if (checked === undefined) throw commandError(ERRORS.invalidValue);
    if (target.key === FEATURES.BINARY && checked === 0) return this.off(lamp);
    const action = target.key === FEATURES.BINARY ? 'on' : target.key;
    return this.command(lamp, action, checked);
  }

  /** On, brightness, colour, temperature. */
  async command(lamp, action, value) {
    const id = (this.seq += 1);
    const arrived = this.monotonic();
    if (!this.configRead) throw commandError(ERRORS.configUnread);
    const bridge = this.config.bridge;
    if (!bridge) throw commandError(ERRORS.notConfigured);
    const packets = packetsFor(bridge.version, lamp.kind, lamp.zone, action, value);
    if (!packets) throw commandError(ERRORS.notThisBridge);
    const listed = this.config.lamps.some((l) => lampId(l) === lampId(lamp));
    if (!listed) throw commandError(ERRORS.notListed);
    if (bridge.version === VERSIONS.V6 && !this.memory) throw commandError(ERRORS.storeUnread);
    if (!this.identityOk()) throw commandError(ERRORS.otherBridge);
    const link = this.useBridge(bridge);
    let result;
    try {
      result = await link.submit({
        id,
        zone: lampId(lamp),
        packets,
        deadline: arrived + this.timings.ackBudget,
        startBy: arrived + this.timings.startBudget,
        guard: () => this.identityOk(),
      });
    } catch (err) {
      if (err.sent > 0) this.newerLeft(lamp);
      if (err.kind === 'refused') throw commandError(ERRORS.otherBridge);
      if (err.kind === 'cancelled' && err.sent > 0) throw commandError(ERRORS.partly);
      throw commandError(ERRORS[err.kind] ?? ERRORS.noAnswer);
    }
    this.newerLeft(lamp);
    if (link.v6 && !result.acked) throw commandError(ERRORS.unconfirmed);
    if (action !== 'on') await this.publishAssumed(lamp, FEATURES.BINARY, 1);
  }

  /** A command of the lamp left (whatever its outcome): a held "off" older than it is dropped. */
  newerLeft(lamp) {
    const id = lampId(lamp);
    const entry = this.held.get(id);
    const left = this.link?.lastSent.get(id) ?? 0;
    if (entry && left > entry.id) this.release(id, { lost: false });
  }

  /** The protective command: never refused for a reason other than "no bridge known". */
  async off(lamp) {
    if (this.stopped) throw commandError(ERRORS.closed);
    const id = (this.seq += 1);
    const arrived = this.monotonic();
    const zone = lampId(lamp);
    const bridge = this.offBridge();
    if (!bridge) throw commandError(ERRORS.notConfigured);
    const packets = packetsFor(bridge.version, lamp.kind, lamp.zone, 'off');
    if (!packets) throw commandError(ERRORS.notThisBridge);
    const link = this.useBridge(bridge);
    // A newer "off" replaces the resends of the previous one.
    for (const handle of this.resends.get(zone) ?? []) this.timers.clearTimeout(handle);
    this.resends.delete(zone);
    this.lastOff.set(zone, id);
    const outcome = await this.sendOff(link, zone, id, packets, arrived);
    if (outcome.confirmed) {
      this.release(zone, { lost: false });
      return;
    }
    if (outcome.overtaken) throw commandError(ERRORS.overtaken);
    // A newer "off" of the lamp took over: it holds itself if it needs to.
    if (this.lastOff.get(zone) !== id) throw commandError(ERRORS.offUnconfirmed);
    this.hold(zone, id, this.timings.heldFor, { at: this.now() });
    throw commandError(outcome.sent > 0 ? ERRORS.offUnconfirmed : ERRORS.offUnsent);
  }

  /**
   * Sends an "off" three times (at once, then the resend delays), each resend
   * skipped when a newer command of the lamp has left. Resolves at the first
   * confirmation (v6: acknowledged; legacy: sent), or when every send ended,
   * within the answer budget: `{ confirmed, sent, overtaken }`.
   */
  sendOff(link, zone, id, packets, arrived) {
    return new Promise((resolve) => {
      let sent = 0;
      let pending = 0;
      let done = false;
      let scheduled = 0;
      const total = 1 + this.timings.offResends.length;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(budget);
        resolve(outcome);
      };
      // A datagram of this "off" (or of a newer command) left: known from the link at once,
      // the acknowledgements may still be awaited when the budget ends.
      const left = () => Math.max(sent, (link.lastSent.get(zone) ?? 0) >= id ? 1 : 0);
      const budget = this.timers.setTimeout(
        () => finish({ confirmed: false, sent: left(), overtaken: false }),
        this.timings.ackBudget,
      );
      const attempt = () => {
        if (link.closed) {
          scheduled += 1;
          if (scheduled === total && pending === 0)
            finish({ confirmed: false, sent, overtaken: false });
          return;
        }
        scheduled += 1;
        pending += 1;
        link
          .submit({
            id,
            zone,
            packets,
            protective: true,
            deadline: arrived + this.timings.ackBudget,
          })
          .then(
            (r) => {
              sent += r.sent;
              if (link.v6 ? r.acked : r.sent > 0) {
                finish({ confirmed: true, sent, overtaken: false });
              }
            },
            (err) => {
              sent += err.sent ?? 0;
            },
          )
          .finally(() => {
            pending -= 1;
            if (scheduled === total && pending === 0) {
              finish({ confirmed: false, sent, overtaken: false });
            }
          });
      };
      attempt();
      const handles = this.timings.offResends.map((delay) => {
        const handle = this.timers.setTimeout(
          () => {
            const list = this.resends.get(zone);
            if (list) {
              const i = list.indexOf(handle);
              if (i !== -1) list.splice(i, 1);
            }
            if ((link.lastSent.get(zone) ?? 0) > id) {
              // A newer command of the lamp left: no resend over it.
              scheduled += 1;
              if (!done && scheduled === total && pending === 0) {
                finish({ confirmed: false, sent, overtaken: true });
              }
              return;
            }
            attempt();
          },
          Math.max(0, arrived + delay - this.monotonic()),
        );
        return handle;
      });
      this.resends.set(zone, handles);
    });
  }

  /** Holds an "off": tried again every 30 s until confirmed, overtaken or `left` ms passed. */
  hold(zone, id, left, { at, now = false }) {
    const previous = this.held.get(zone);
    if (previous?.timer !== undefined) this.timers.clearTimeout(previous.timer);
    if (left <= 0) {
      this.held.delete(zone);
      return;
    }
    this.lost.delete(zone);
    const entry = { id, until: this.monotonic() + left, timer: undefined };
    this.held.set(zone, entry);
    if (this.memory) {
      this.memory.held[zone] = at;
      this.saveMemory();
    }
    this.publishBadges();
    const schedule = (delay) => {
      entry.timer = this.timers.setTimeout(() => {
        entry.timer = undefined;
        this.retryHeld(zone, entry).then((again) => {
          if (again && this.held.get(zone) === entry && !this.stopped) {
            schedule(this.timings.heldRetry);
          }
        });
      }, delay);
    };
    schedule(now ? 0 : this.timings.heldRetry);
  }

  async retryHeld(zone, entry) {
    if (this.stopped || this.held.get(zone) !== entry) return false;
    const lamp = lampOf(zone);
    const bridge = this.offBridge();
    if (this.monotonic() >= entry.until) {
      this.release(zone, { lost: true });
      return false;
    }
    if (!bridge) return true;
    const link = this.useBridge(bridge);
    const packets = packetsFor(bridge.version, lamp.kind, lamp.zone, 'off');
    if (!packets) {
      this.release(zone, { lost: true });
      return false;
    }
    const outcome = await this.sendOff(link, zone, entry.id, packets, this.monotonic());
    if (this.held.get(zone) !== entry) return false;
    if (outcome.overtaken) {
      this.release(zone, { lost: false });
      return false;
    }
    if (outcome.confirmed) {
      this.release(zone, { lost: false });
      // Gladys kept "on" (the click was answered with a failure): the off is now known.
      await this.publishAssumed(lamp, FEATURES.BINARY, 0);
      return false;
    }
    return true;
  }

  release(zone, { lost }) {
    const entry = this.held.get(zone);
    if (entry?.timer !== undefined) this.timers.clearTimeout(entry.timer);
    const had = this.held.delete(zone);
    if (lost) this.lost.add(zone);
    else this.lost.delete(zone);
    if (this.memory && Object.hasOwn(this.memory.held, zone)) {
      delete this.memory.held[zone];
      this.saveMemory();
    }
    if (had || lost) this.publishBadges();
  }

  // --- "Test the bridge" ----------------------------------------------------------

  async testBridge() {
    const c = this.config;
    if (!this.configRead) return this.configError ?? T.configUnread(0);
    if (!c.bridge)
      return c.invalid ? T.invalidAddress : c.broadcast ? T.broadcastAddress : T.noAddress;
    if (c.bridge.version === VERSIONS.LEGACY) return T.testLegacy(c.bridge);
    const mono = this.monotonic();
    if (mono - this.lastTestAt < this.timings.testSpacing) {
      return T.testTooSoon(this.lastTestAt + this.timings.testSpacing - mono);
    }
    this.lastTestAt = mono;
    const link = this.useBridge(c.bridge);
    try {
      await link.ensureSession({ force: true });
    } catch {
      return T.v6NoAnswer(c.bridge);
    }
    const seen = link.mac;
    const pinned = this.memory?.mac;
    if (!this.memory) return T.storeUnread;
    if (!pinned || pinned === seen) {
      this.acceptPending = undefined;
      return T.v6Ok(seen);
    }
    const pending = this.acceptPending;
    if (pending && pending.mac === seen && mono - pending.at < this.timings.acceptWithin) {
      const before = this.memory.mac;
      this.memory.mac = seen;
      if (!(await this.saveMemory())) {
        this.memory.mac = before;
        return T.testNotSaved;
      }
      this.acceptPending = undefined;
      await this.publishStatus();
      return T.testAccepted(seen);
    }
    this.acceptPending = { mac: seen, at: mono };
    return T.testAcceptAgain(seen, pinned);
  }
}
