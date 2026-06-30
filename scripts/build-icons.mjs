// Generates the PWA app icons programmatically — no image dependency required.
//
// The game is audio / echolocation themed, so the icon is a "sonar ping": a bright
// centre dot with concentric sound-wave arcs radiating from it, on a near-black
// field (matches the manifest theme/background `#000`). We draw straight into an
// RGBA pixel buffer and encode a valid PNG by hand (zlib is in Node core), so the
// build needs no `sharp`/`canvas` native dependency.
//
// Outputs (paths the VitePWA manifest references):
//   assets/icons/icon-192.png          192x192  (any)
//   assets/icons/icon-512.png          512x512  (any)
//   assets/icons/icon-maskable-512.png 512x512  (safe-zone padded, maskable)
//
// `assets/` is copied verbatim into `dist/assets/` by the copyAssets() Vite plugin,
// so these ship with the build. Run via `node scripts/build-icons.mjs`.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../assets/icons');

// --- tiny PNG encoder (truecolour + alpha, 8-bit) ---------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // 10,11,12 = compression, filter, interlace = 0
  // each scanline prefixed with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the artwork -------------------------------------------------------------
function drawIcon(size, { padFrac = 0 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // usable radius (maskable variant pads in to keep art inside the safe zone)
  const R = (size / 2) * (1 - padFrac);

  // brand colours
  const bg = [10, 12, 16];          // near-black field
  const ring = [80, 200, 255];      // cyan sonar arcs
  const dot = [120, 230, 255];      // bright ping core

  // arcs: radii as fractions of R, fading out with distance
  const arcs = [0.30, 0.52, 0.74, 0.94];
  const arcWidth = size * 0.035;
  const dotR = size * 0.055;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);

      let r = bg[0], g = bg[1], b = bg[2];

      // subtle radial vignette so it reads on dark + light launchers
      const vig = Math.max(0, 1 - (d / (size / 2)) * 0.5);
      r = Math.round(r * (0.6 + 0.4 * vig));
      g = Math.round(g * (0.6 + 0.4 * vig));
      b = Math.round(b * (0.6 + 0.4 * vig));

      // sonar arcs (full rings here; clean and symmetric at icon sizes)
      for (let i = 0; i < arcs.length; i++) {
        const ar = arcs[i] * R;
        const dist = Math.abs(d - ar);
        if (dist < arcWidth) {
          // antialiased edge + fade outer arcs
          const edge = 1 - dist / arcWidth;
          const fade = 1 - i * 0.18;
          const a = Math.min(1, edge * 1.6) * fade;
          r = Math.round(r * (1 - a) + ring[0] * a);
          g = Math.round(g * (1 - a) + ring[1] * a);
          b = Math.round(b * (1 - a) + ring[2] * a);
        }
      }

      // centre ping dot with soft glow
      if (d < dotR * 2.2) {
        const a = Math.max(0, 1 - d / (dotR * 2.2));
        const a2 = d < dotR ? 1 : a * a;
        r = Math.round(r * (1 - a2) + dot[0] * a2);
        g = Math.round(g * (1 - a2) + dot[1] * a2);
        b = Math.round(b * (1 - a2) + dot[2] * a2);
      }

      const o = (y * size + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255; // fully opaque (manifest field is dark; maskable fills frame)
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // Maskable: art kept inside the ~80% safe zone so launcher masks don't clip it.
  ['icon-maskable-512.png', 512, { padFrac: 0.12 }],
];
for (const [name, size, opts] of targets) {
  const png = drawIcon(size, opts);
  writeFileSync(resolve(outDir, name), png);
  console.log(`wrote assets/icons/${name} (${size}x${size}, ${png.length} bytes)`);
}
