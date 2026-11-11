// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600):
//   - `bridge`: the address, port and family of the bridge last configured,
//     so that a held "off" leaves after a restart before the configuration
//     is read;
//   - `mac`: the MAC address of the v6 bridge first seen (pinned): another
//     bridge answering at the address gets no command but "off" until the
//     "Test the bridge" button accepts it (two clicks);
//   - `held`: per lamp, the wall-clock time of an "off" not confirmed yet
//     (tried again every 30 s for 10 min after the click, restart included);
//   - `lastCheckAt`: when the v6 bridge was last checked (written BEFORE the
//     check), so that a restart never checks sooner than 5 min.
// An unreadable file is never taken as an empty one: no pin is learnt and
// nothing is written over it until it reads again.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { parseAddress } from './config.js';
import { LIMITS, VERSIONS } from './constants.js';
import { lampOf } from './devices.js';

export const STATE_FILE = '/data/milight-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ ok: true, data }` (data null when there is no file yet) or `{ ok: false }`. */
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        if (text.length > LIMITS.storeBytes) return { ok: false };
        return { ok: true, data: JSON.parse(text) };
      } catch (err) {
        return err?.code === 'ENOENT' ? { ok: true, data: null } : { ok: false };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file, with failures on demand. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable: false,
    unwritable: false,
    loads: 0,
    async load() {
      this.loads += 1;
      if (this.unreadable) return { ok: false };
      return { ok: true, data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.unwritable) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** A wall-clock time: positive, never in the future (a clock that jumped, a file edited by hand). */
const time = (value, now) =>
  Number.isFinite(value) && value > 0 && value <= now ? value : undefined;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/** The persisted state, repaired and bounded. */
export function normalizeMemory(raw, now, heldFor) {
  const data = object(raw);
  const b = object(data.bridge);
  const bridge =
    typeof b.host === 'string' &&
    // The same rule as the configuration: one unicast IPv4 address, never a broadcast.
    parseAddress(b.host).address?.host === b.host &&
    Number.isInteger(b.port) &&
    b.port > 0 &&
    b.port < 65536 &&
    Object.values(VERSIONS).includes(b.version)
      ? { host: b.host, port: b.port, version: b.version }
      : undefined;
  const held = {};
  for (const [id, at] of Object.entries(object(data.held)).slice(0, 32)) {
    const t = time(at, now);
    if (lampOf(id) && t !== undefined && now - t < heldFor) held[id] = t;
  }
  return {
    bridge,
    mac: typeof data.mac === 'string' && MAC.test(data.mac) ? data.mac : undefined,
    held,
    lastCheckAt: time(data.lastCheckAt, now) ?? 0,
  };
}
