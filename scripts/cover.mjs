// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-violet gradient,
// three bulbs (red, green, blue) lit by the small Wi-Fi bridge under them,
// with the radio waves going one way only (the bulbs never answer). Plain
// Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [16, 14, 36];
const VIOLET = [70, 40, 120];
const WHITE = [255, 255, 255];
const BULBS = [
  [230, [255, 80, 90]],
  [400, [90, 230, 140]],
  [570, [90, 150, 255]],
];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixel(x, y) {
  let color = mix(DARK, VIOLET, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  for (const [cx, tint] of BULBS) {
    // Glow, glass and base of each bulb.
    const d = Math.hypot(x - cx, y - 190);
    color = mix(color, tint, Math.max(0, 1 - d / 150) * 0.45);
    color = mix(color, tint, smooth(62, d) * 0.95);
    color = mix(color, WHITE, smooth(18, Math.hypot(x - cx + 20, y - 170)) * 0.35);
    color = mix(color, WHITE, smooth(1, roundedBox(x, y, cx, 272, 26, 18, 6)) * 0.85);
  }
  // The bridge, and its waves going up only.
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 400, 450, 70, 26, 12)) * 0.9);
  color = mix(color, [90, 230, 140], smooth(6, Math.hypot(x - 445, y - 450)));
  const hub = Math.hypot(x - 400, y - 420);
  for (const radius of [40, 62, 84]) {
    if (y < 410 && Math.abs(x - 400) < 70) {
      color = mix(color, WHITE, smooth(3, Math.abs(hub - radius)) * 0.6);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
