// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with what a form may send. There is no secret:
// a MiLight bridge has no password.
// -----------------------------------------------------------------------------

import { KIND_VERSIONS, KINDS, PORTS, VERSIONS, ZONES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  bridge_address: '',
  bridge_version: VERSIONS.V6,
  full_color_zones: [],
  rgbw_zones: [],
  white_zones: [],
  bridge_lamp: false,
  language: 'fr',
};

/** The config key listing the zones of each kind. */
export const ZONE_KEYS = {
  [KINDS.FULL_COLOR]: 'full_color_zones',
  [KINDS.RGBW]: 'rgbw_zones',
  [KINDS.WHITE]: 'white_zones',
};

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/**
 * The address typed by the user: an IPv4 address of the local network, with
 * an optional port (5987 for a v6 bridge, 8899 for a legacy one). A pasted
 * URL is reduced to its host. Never a broadcast, multicast or "any" address:
 * the bridge has one address. An invalid entry is never shown back.
 * @returns {{ address?: { host: string, port?: number }, invalid?: boolean, broadcast?: boolean }}
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') return {};
  if (text.length > 100 || /[\s@\\]/.test(text)) return { invalid: true };
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([\d.]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match || !IPV4.test(match[1])) return { invalid: true };
  const [, host, portText] = match;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (port < 1 || port > 65535)) return { invalid: true };
  const octets = host.split('.').map(Number);
  if (
    octets[0] === 0 ||
    octets[0] >= 224 ||
    octets[3] === 255 ||
    (octets[3] === 0 && octets[0] !== 127)
  ) {
    return { broadcast: true };
  }
  return { address: { host, port } };
}

/** The zones chosen in a multi_select: integers 1..4, sorted, unique. */
export function zonesOf(value) {
  if (!Array.isArray(value)) return [];
  const zones = new Set();
  for (const item of value.slice(0, 16)) {
    const n = typeof item === 'number' ? item : /^[1-4]$/.test(String(item)) ? Number(item) : NaN;
    if (ZONES.includes(n)) zones.add(n);
  }
  return [...zones].sort((a, b) => a - b);
}

/**
 * @returns {{ bridge?: { host: string, port: number, version: 'v6'|'legacy' },
 *   invalid: boolean, broadcast: boolean, version: 'v6'|'legacy',
 *   lamps: { kind: string, zone: number }[], skipped: string[], language: 'fr'|'en' }}
 */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) c[key] = value;
  }
  const version = c.bridge_version === VERSIONS.LEGACY ? VERSIONS.LEGACY : VERSIONS.V6;
  const parsed = parseAddress(typeof c.bridge_address === 'string' ? c.bridge_address : '');
  const bridge = parsed.address
    ? { host: parsed.address.host, port: parsed.address.port ?? PORTS[version], version }
    : undefined;
  const lamps = [];
  const skipped = [];
  for (const [kind, key] of Object.entries(ZONE_KEYS)) {
    const zones = zonesOf(c[key]);
    if (zones.length > 0 && !KIND_VERSIONS[kind].includes(version)) {
      skipped.push(kind);
      continue;
    }
    for (const zone of zones) lamps.push({ kind, zone });
  }
  if (c.bridge_lamp === true) {
    if (version === VERSIONS.V6) lamps.push({ kind: KINDS.BRIDGE_LAMP, zone: 0 });
    else skipped.push(KINDS.BRIDGE_LAMP);
  }
  return {
    bridge,
    invalid: Boolean(parsed.invalid),
    broadcast: Boolean(parsed.broadcast),
    version,
    lamps,
    skipped,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** `host:port/version`: a change of it starts the link over. */
export const bridgeKey = (bridge) =>
  bridge ? `${bridge.host}:${bridge.port}/${bridge.version}` : '';
