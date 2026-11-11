// -----------------------------------------------------------------------------
// The MiLight / LimitlessLED UDP protocol, written from the LimitlessLED
// developer page (v3-v5 "legacy" bridges and the v6 iBox bridges). The colour
// offsets of the v6 wheels come from node-milight-promise (MIT, see
// THIRD_PARTY_NOTICES.md). Pure functions: bytes in, bytes out.
//
// Legacy (v3-v5, port 8899): one 3-byte datagram per order, [code, value,
// 0x55]; the bridge never answers. A zone is "selected" by its ON code, which
// also lights it: brightness, colour and white follow an ON of the zone.
//
// v6 (iBox 1/2, port 5987): a session is asked first (the answer carries the
// MAC address of the bridge and a 2-byte session id), then each order is a
// 22-byte datagram with the session id, a sequence number, 9 bytes of order,
// the zone and a checksum; the bridge acknowledges it with the sequence number
// (an acknowledgement of the BRIDGE: the bulbs, on 2.4 GHz, never answer).
// -----------------------------------------------------------------------------

import { KELVIN, KINDS, MIRED } from './constants.js';

// --- v6 framing ---------------------------------------------------------------

/** The session request of the developer page. */
export const SESSION_REQUEST = Buffer.from([
  0x20, 0x00, 0x00, 0x00, 0x16, 0x02, 0x62, 0x3a, 0xd5, 0xed, 0xa3, 0x01, 0xae, 0x08, 0x2d, 0x46,
  0x61, 0x41, 0xa7, 0xf6, 0xdc, 0xaf, 0xd3, 0xe6, 0x00, 0x00, 0x1e,
]);

const SESSION_HEADER = [0x28, 0x00, 0x00, 0x00, 0x11];
const ACK_HEADER = [0x88, 0x00, 0x00, 0x00, 0x03, 0x00];

const startsWith = (buf, head) => head.every((b, i) => buf[i] === b);

/**
 * The answer to a session request: `{ mac: 'ac:cf:23:f5:7a:d4', session: [b1, b2] }`,
 * or undefined for anything else (another kind of datagram, cut, too long).
 */
export function parseSession(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 22 || !startsWith(buf, SESSION_HEADER)) {
    return undefined;
  }
  const macBytes = [...buf.subarray(7, 13)];
  if (macBytes.every((b) => b === 0) || macBytes.every((b) => b === 0xff)) {
    return undefined;
  }
  return {
    mac: macBytes.map((b) => b.toString(16).padStart(2, '0')).join(':'),
    session: [buf[19], buf[20]],
  };
}

/** The sequence number an acknowledgement carries, or undefined. */
export function parseAck(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 8 || !startsWith(buf, ACK_HEADER)) {
    return undefined;
  }
  return buf[7] === 0x00 ? buf[6] : undefined;
}

/** A v6 order: 9 bytes starting with 0x31, the zone, framed and summed. */
export function v6Frame(session, seq, order, zone) {
  if (order.length !== 9 || order[0] !== 0x31) {
    throw new Error('a v6 order is 9 bytes starting with 0x31');
  }
  const body = [...order, zone & 0xff, 0x00];
  const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
  return Buffer.from([
    0x80,
    0x00,
    0x00,
    0x00,
    0x11,
    session[0] & 0xff,
    session[1] & 0xff,
    0x00,
    seq & 0xff,
    0x00,
    ...body,
    checksum,
  ]);
}

// --- colours ------------------------------------------------------------------

/** 0xRRGGBB -> { h: 0..360, s: 0..1, v: 0..1 }. */
export function rgbToHsv(color) {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Below this saturation a colour is taken as white (RGBW lamps have a white LED). */
export const WHITE_SATURATION = 0.15;

/** The hue on 256 steps (0 = red, growing towards yellow, green, blue). */
const hue256 = (h) => Math.round((h * 256) / 360) & 0xff;

/** Legacy colour wheel: 0xB0 is red, the byte goes down from red to yellow, green, blue. */
export const legacyHue = (h) => (0xb0 - hue256(h)) & 0xff;

/**
 * The v6 wheels are the legacy one mirrored and shifted, by kind
 * (node-milight-promise: 0xFF - legacy - 0x37 / 0x48 / 0x52).
 */
export const V6_HUE_SHIFT = {
  [KINDS.RGBW]: 0x18,
  [KINDS.FULL_COLOR]: 0x07,
  [KINDS.BRIDGE_LAMP]: 0xfd,
};
export const v6Hue = (kind, h) => (V6_HUE_SHIFT[kind] + hue256(h)) & 0xff;

/** Mireds (153..370) -> the v6 white temperature byte (0 = 2700 K, 100 = 6500 K). */
export function kelvinByte(mired) {
  const m = Math.min(MIRED.max, Math.max(MIRED.min, mired));
  const kelvin = 1e6 / m;
  const byte = Math.round(((kelvin - KELVIN.warm) * 100) / (KELVIN.cold - KELVIN.warm));
  return Math.min(100, Math.max(0, byte));
}

/** Brightness 1..100 % -> the legacy byte 0x02..0x1B. */
export const legacyBrightness = (pct) => 0x02 + Math.round(((pct - 1) * 25) / 99);

// --- orders by kind -------------------------------------------------------------

const v6 = (type, a, b, c = 0, d = 0, e = 0) => [0x31, 0x00, 0x00, type, a, b, c, d, e];

/** Type byte and order codes of each v6 kind (developer page, v6 section). */
const V6_ORDERS = {
  [KINDS.FULL_COLOR]: {
    on: () => v6(0x08, 0x04, 0x01),
    off: () => v6(0x08, 0x04, 0x02),
    brightness: (b) => v6(0x08, 0x03, b),
    hue: (h) => v6(0x08, 0x01, h, h, h, h),
    // 0 is the full colour, 100 no colour (white).
    saturation: (s) => v6(0x08, 0x02, s),
    kelvin: (k) => v6(0x08, 0x05, k),
  },
  [KINDS.RGBW]: {
    on: () => v6(0x07, 0x03, 0x01),
    off: () => v6(0x07, 0x03, 0x02),
    white: () => v6(0x07, 0x03, 0x05),
    brightness: (b) => v6(0x07, 0x02, b),
    hue: (h) => v6(0x07, 0x01, h, h, h, h),
  },
  [KINDS.WHITE]: {
    on: () => v6(0x01, 0x01, 0x07),
    off: () => v6(0x01, 0x01, 0x08),
  },
  [KINDS.BRIDGE_LAMP]: {
    on: () => v6(0x00, 0x03, 0x03),
    off: () => v6(0x00, 0x03, 0x04),
    white: () => v6(0x00, 0x03, 0x05),
    brightness: (b) => v6(0x00, 0x02, b),
    hue: (h) => v6(0x00, 0x01, h, h, h, h),
  },
};

/** Legacy codes by zone 1..4 (developer page, v3-v5 section). */
const LEGACY_CODES = {
  [KINDS.RGBW]: {
    on: [0x45, 0x47, 0x49, 0x4b],
    off: [0x46, 0x48, 0x4a, 0x4c],
    white: [0xc5, 0xc7, 0xc9, 0xcb],
  },
  [KINDS.WHITE]: {
    on: [0x38, 0x3d, 0x37, 0x32],
    off: [0x3b, 0x33, 0x3a, 0x36],
  },
};

const legacy = (code, value = 0x00) => ({ legacy: Buffer.from([code, value, 0x55]) });

/**
 * The datagrams of one command, in order: `[{ v6: order9, zone } | { legacy: Buffer }]`.
 * `action` is on, off, brightness (1..100), color (0xRRGGBB) or temperature
 * (mireds); the value is already checked. Undefined when the kind cannot do it
 * on this bridge.
 */
export function packetsFor(version, kind, zone, action, value) {
  if (version === 'legacy') {
    const codes = LEGACY_CODES[kind];
    if (!codes) return undefined;
    const i = zone - 1;
    const on = legacy(codes.on[i]);
    switch (action) {
      case 'on':
        return [on];
      case 'off':
        return [legacy(codes.off[i])];
      case 'brightness':
        return kind === KINDS.RGBW ? [on, legacy(0x4e, legacyBrightness(value))] : undefined;
      case 'color': {
        if (kind !== KINDS.RGBW) return undefined;
        const hsv = rgbToHsv(value);
        return hsv.s < WHITE_SATURATION
          ? [on, legacy(codes.white[i])]
          : [on, legacy(0x40, legacyHue(hsv.h))];
      }
      default:
        return undefined;
    }
  }
  const orders = V6_ORDERS[kind];
  if (!orders) return undefined;
  const z = kind === KINDS.BRIDGE_LAMP ? 0x01 : zone;
  const p = (order) => ({ v6: order, zone: z });
  switch (action) {
    case 'on':
      return [p(orders.on())];
    case 'off':
      return [p(orders.off())];
    case 'brightness':
      return orders.brightness ? [p(orders.on()), p(orders.brightness(value))] : undefined;
    case 'color': {
      if (!orders.hue) return undefined;
      const hsv = rgbToHsv(value);
      if (orders.saturation) {
        const sat = 100 - Math.round(hsv.s * 100);
        return [p(orders.on()), p(orders.hue(v6Hue(kind, hsv.h))), p(orders.saturation(sat))];
      }
      return hsv.s < WHITE_SATURATION
        ? [p(orders.on()), p(orders.white())]
        : [p(orders.on()), p(orders.hue(v6Hue(kind, hsv.h)))];
    }
    case 'temperature':
      return orders.kelvin ? [p(orders.on()), p(orders.kelvin(kelvinByte(value)))] : undefined;
    default:
      return undefined;
  }
}
