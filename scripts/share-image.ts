// The 1200×630 share image (og.png), drawn in code at build time: no image files, no
// fonts and no packages. Shapes are signed distance functions, rasterised with one pixel
// of anti-aliasing; the PNG is written with node:zlib.
//
//   ┌──────────────────────────────────────────────┐   brand blue, darker towards the bottom
//   │  [✓]  grantgate                               │   the logo, and the name drawn as strokes
//   │  ┌────────────────────────────────────────┐   │
//   │  │ (HIGH) ─────────────────          ⛔    │   a white card like the interstitial:
//   │  │ (HIGH) ────────────────────             │   two high-risk permissions, one low,
//   │  │ (LOW)  ──────────                       │   "Go back" and "Continue", and the
//   │  │ [Go back] [Continue just this once]     │   no-entry sign of a stopped sign-in
//   │  └────────────────────────────────────────┘   │
//   └──────────────────────────────────────────────┘

import { deflateSync } from 'node:zlib';
import { SHARE_IMAGE } from './site-pages.ts';

type Rgb = readonly [number, number, number];

// The site's own colours (site/styles.css).
export const BRAND: Rgb = [0x1a, 0x56, 0xdb];
const BRAND_DARK: Rgb = [0x1e, 0x42, 0x9f];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const LINE: Rgb = [0xe5, 0xe7, 0xeb];
const BORDER: Rgb = [0xd1, 0xd5, 0xdb];
const HIGH: Rgb = [0xc5, 0x22, 0x1f];
const LOW: Rgb = [0x13, 0x73, 0x33];

/** A shape: its signed distance in pixels (negative inside) and the box it lies in. */
interface Shape {
  box: readonly [number, number, number, number];
  distance(x: number, y: number): number;
}

function capsule(x1: number, y1: number, x2: number, y2: number, width: number): Shape {
  const half = width / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy || 1;
  return {
    box: [Math.min(x1, x2) - half, Math.min(y1, y2) - half, Math.max(x1, x2) + half, Math.max(y1, y2) + half],
    distance(x, y) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length2));
      return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - half;
    },
  };
}

function circle(cx: number, cy: number, r: number): Shape {
  return { box: [cx - r, cy - r, cx + r, cy + r], distance: (x, y) => Math.hypot(x - cx, y - cy) - r };
}

function roundRect(x: number, y: number, w: number, h: number, r: number): Shape {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    box: [x, y, x + w, y + h],
    distance(px, py) {
      const qx = Math.abs(px - cx) - (w / 2 - r);
      const qy = Math.abs(py - cy) - (h / 2 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    },
  };
}

/**
 * A stroked arc with round ends. Angles are in degrees, counter-clockwise from 3 o'clock
 * (so 90 is the top), from `from` round to `to`.
 */
function arc(cx: number, cy: number, r: number, from: number, to: number, width: number): Shape {
  const half = width / 2;
  const span = (((to - from) % 360) + 360) % 360 || 360;
  const end = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)];
  const [ax, ay] = end(from);
  const [bx, by] = end(to);
  return {
    box: [cx - r - half, cy - r - half, cx + r + half, cy + r + half],
    distance(x, y) {
      const angle = (Math.atan2(cy - y, x - cx) * 180) / Math.PI;
      const into = (((angle - from) % 360) + 360) % 360;
      if (into <= span) return Math.abs(Math.hypot(x - cx, y - cy) - r) - half;
      return Math.min(Math.hypot(x - ax, y - ay), Math.hypot(x - bx, y - by)) - half;
    },
  };
}

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
  }

  /** Fills every row with a colour running from `top` to `bottom`. */
  gradient(top: Rgb, bottom: Rgb): void {
    for (let y = 0; y < this.height; y++) {
      const t = y / (this.height - 1);
      const rgb = top.map((c, i) => Math.round(c + (bottom[i] - c) * t));
      for (let x = 0; x < this.width; x++) this.pixels.set([rgb[0], rgb[1], rgb[2], 255], (y * this.width + x) * 4);
    }
  }

  /** Paints the union of `shapes` in `colour`, anti-aliased over one pixel. */
  fill(shapes: Shape[], colour: Rgb): void {
    const x0 = Math.max(0, Math.floor(Math.min(...shapes.map((s) => s.box[0])) - 1));
    const y0 = Math.max(0, Math.floor(Math.min(...shapes.map((s) => s.box[1])) - 1));
    const x1 = Math.min(this.width, Math.ceil(Math.max(...shapes.map((s) => s.box[2])) + 1));
    const y1 = Math.min(this.height, Math.ceil(Math.max(...shapes.map((s) => s.box[3])) + 1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let d = Infinity;
        for (const shape of shapes) d = Math.min(d, shape.distance(x + 0.5, y + 0.5));
        const alpha = Math.max(0, Math.min(1, 0.5 - d));
        if (alpha === 0) continue;
        const at = (y * this.width + x) * 4;
        for (let i = 0; i < 3; i++) this.pixels[at + i] = Math.round(this.pixels[at + i] * (1 - alpha) + colour[i] * alpha);
      }
    }
  }
}

/**
 * "grantgate" in a geometric stroke face, drawn at `x` with the x-height between `top` and
 * `top + size`. Returns the shapes; only the six letters the name needs are defined.
 */
function wordmark(text: string, x: number, top: number, size: number): Shape[] {
  const w = size * 0.22; // stroke width
  const r = (size - w) / 2; // bowl radius, to the middle of the stroke
  const mid = top + size / 2;
  const base = top + size - w / 2; // where a stroke ends so its round cap sits on the baseline
  const gap = size * 0.2;
  const shapes: Shape[] = [];
  let pen = x;
  for (const letter of text) {
    const left = pen + w / 2; // a stem's centre line, on the letter's left edge
    let advance: number;
    switch (letter) {
      case 'a':
      case 'g': {
        const stem = left + 2 * r;
        shapes.push(arc(left + r, mid, r, 0, 360, w));
        if (letter === 'a') {
          shapes.push(capsule(stem, top + w / 2, stem, base, w));
        } else {
          const hook = r * 0.85;
          shapes.push(capsule(stem, top + w / 2, stem, top + size, w), arc(stem - hook, top + size, hook, 180, 360, w));
        }
        advance = 2 * r + w;
        break;
      }
      case 'r':
        shapes.push(capsule(left, top + w / 2, left, base, w), arc(left + r, mid, r, 55, 180, w));
        advance = r * (1 + Math.cos((55 * Math.PI) / 180)) + w;
        break;
      case 'n':
        shapes.push(capsule(left, top + w / 2, left, base, w), arc(left + r, mid, r, 0, 180, w), capsule(left + 2 * r, mid, left + 2 * r, base, w));
        advance = 2 * r + w;
        break;
      case 't': {
        const stem = left + size * 0.12;
        shapes.push(capsule(stem, top - size * 0.3, stem, base, w), capsule(left, top + w / 2, stem + size * 0.3, top + w / 2, w));
        advance = size * 0.42 + w;
        break;
      }
      case 'e':
        shapes.push(arc(left + r, mid, r, 0, 320, w), capsule(left, mid, left + 2 * r, mid, w));
        advance = 2 * r + w;
        break;
      default:
        throw new Error(`the wordmark has no letter "${letter}"`);
    }
    pen += advance + gap;
  }
  return shapes;
}

/** The share card, as PNG bytes. The same bytes on every build. */
export function shareImagePng(): Buffer {
  const { width, height } = SHARE_IMAGE;
  const canvas = new Canvas(width, height);
  canvas.gradient(BRAND, BRAND_DARK);

  // The logo (the site's favicon: a check on a rounded square), then the name beside it.
  const logo = { x: 96, y: 84, size: 120 };
  const unit = logo.size / 32;
  canvas.fill([roundRect(logo.x, logo.y, logo.size, logo.size, 8 * unit)], WHITE);
  const point = (px: number, py: number): [number, number] => [logo.x + px * unit, logo.y + py * unit];
  canvas.fill(
    [capsule(...point(9, 16.5), ...point(13.5, 21), 3.5 * unit), capsule(...point(13.5, 21), ...point(23, 11), 3.5 * unit)],
    BRAND,
  );
  canvas.fill(wordmark('grantgate', 252, 112, 64), WHITE);

  // A card like the interstitial, stopping a request for two high-risk permissions.
  const card = { x: 96, y: 262, w: 1008, h: 284 };
  canvas.fill([roundRect(card.x, card.y, card.w, card.h, 24)], WHITE);
  const rows: [Rgb, number][] = [
    [HIGH, 430],
    [HIGH, 500],
    [LOW, 280],
  ];
  rows.forEach(([colour, length], i) => {
    const y = card.y + 40 + i * 54;
    canvas.fill([roundRect(card.x + 44, y, 112, 30, 15)], colour);
    canvas.fill([roundRect(card.x + 180, y + 6, length, 18, 9)], LINE);
    if (i < rows.length - 1) canvas.fill([roundRect(card.x + 44, y + 42, 660, 2, 1)], LINE);
  });
  const buttons = card.y + card.h - 40 - 46;
  canvas.fill([roundRect(card.x + 44, buttons, 168, 46, 12)], BRAND);
  canvas.fill([roundRect(card.x + 232, buttons, 300, 46, 12)], BORDER);
  canvas.fill([roundRect(card.x + 234, buttons + 2, 296, 42, 10)], WHITE);

  // The no-entry sign: a sign-in held back.
  const sign = { x: card.x + card.w - 170, y: card.y + card.h / 2, r: 92 };
  canvas.fill([circle(sign.x, sign.y, sign.r)], HIGH);
  canvas.fill([capsule(sign.x - sign.r * 0.55, sign.y, sign.x + sign.r * 0.55, sign.y, sign.r * 0.34)], WHITE);

  return encodePng(width, height, canvas.pixels);
}

// ---------------------------------------------------------------------------
// PNG: 8-bit RGBA, no interlace, every row with filter 0.

/** Encodes RGBA pixels (4 bytes each, row by row) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) throw new Error(`a ${width}×${height} image needs ${expected} bytes, not ${rgba.length}`);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (ISO 3309), as PNG chunks use. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
