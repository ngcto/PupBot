/**
 * Draws `build/icon.png` — the app icon — without an image library.
 *
 * The mark is the product's own language: one soft rounded-square silhouette with
 * two eyes, the accent blue used for bot avatars. It reads as a face at 16px and
 * has no fine detail to lose.
 *
 * Regenerate with `pnpm --filter @terabot/desktop icon`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const SAMPLES = 4;

const PAD = 84;
const RADIUS = 224;
const EYE_Y = 452;
const EYE_OFFSET_X = 158;
const EYE_WIDTH = 92;
const EYE_HEIGHT = 208;

const TOP = [0x45, 0x93, 0xff];
const BOTTOM = [0x10, 0x63, 0xd8];
const EYE = [0x0d, 0x0d, 0x10];

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideSquircle(x, y) {
  return insideRoundedRect(x, y, PAD, PAD, SIZE - PAD * 2, SIZE - PAD * 2, RADIUS);
}

function insideEye(x, y) {
  for (const side of [-1, 1]) {
    const left = SIZE / 2 + side * EYE_OFFSET_X - EYE_WIDTH / 2;
    const top = EYE_Y - EYE_HEIGHT / 2;
    if (insideRoundedRect(x, y, left, top, EYE_WIDTH, EYE_HEIGHT, EYE_WIDTH / 2)) return true;
  }
  return false;
}

function sampleColor(x, y) {
  if (!insideSquircle(x, y)) return undefined;
  if (insideEye(x, y)) return EYE;
  const t = (y - PAD) / (SIZE - PAD * 2);
  return [
    Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
  ];
}

function renderRgba() {
  const stride = SIZE * 4;
  const pixels = Buffer.alloc(SIZE * stride);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const color = sampleColor(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered += 1;
        }
      }
      const offset = y * stride + x * 4;
      if (covered === 0) continue;
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / total) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const target = resolve(appDir, "build/icon.png");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encodePng(SIZE, SIZE, renderRgba()));
console.log(`wrote ${target} (${SIZE}x${SIZE})`);
