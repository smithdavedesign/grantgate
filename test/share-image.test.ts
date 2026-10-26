import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { BRAND, crc32, encodePng, shareImagePng } from '../scripts/share-image.ts';
import { SHARE_IMAGE } from '../scripts/site-pages.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

/** Splits a PNG into its chunks, checking each one's CRC. */
function chunks(png: Buffer): Chunk[] {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE, 'PNG signature');
  const found: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    found.push({ type, data });
    at += 12 + length;
  }
  assert.equal(at, png.length, 'no trailing bytes');
  return found;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG whose rows all use filter 0 (what encodePng writes). */
function decode(png: Buffer): { width: number; height: number; pixel(x: number, y: number): number[] } {
  const all = chunks(png);
  assert.equal(all[0].type, 'IHDR');
  assert.equal(all.at(-1)?.type, 'IEND');
  const ihdr = all[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0], 'bit depth 8, RGBA, deflate, no filter method, no interlace');
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = 1 + width * 4;
  assert.equal(raw.length, stride * height);
  for (let y = 0; y < height; y++) assert.equal(raw[y * stride], 0, `row ${y} filter`);
  return {
    width,
    height,
    pixel: (x, y) => [...raw.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)],
  };
}

describe('encodePng', () => {
  it('writes a valid PNG of the given pixels', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]);
    const image = decode(encodePng(2, 2, rgba));
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual(image.pixel(0, 0), [255, 0, 0, 255]);
    assert.deepEqual(image.pixel(1, 0), [0, 255, 0, 255]);
    assert.deepEqual(image.pixel(0, 1), [0, 0, 255, 255]);
    assert.deepEqual(image.pixel(1, 1), [255, 255, 255, 0]);
  });

  it('refuses pixels that do not match the size', () => {
    assert.throws(() => encodePng(2, 2, new Uint8Array(15)), /16 bytes/);
  });

  it('computes the standard CRC-32', () => {
    assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
    assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926);
  });
});

describe('shareImagePng: the 1200×630 share card, drawn in code', () => {
  const png = shareImagePng();
  const image = decode(png);

  it('is 1200×630, as the og:image tags say', () => {
    assert.equal(SHARE_IMAGE.width, 1200);
    assert.equal(SHARE_IMAGE.height, 630);
    assert.equal(image.width, SHARE_IMAGE.width);
    assert.equal(image.height, SHARE_IMAGE.height);
  });

  it('is small enough for every network that fetches it', () => {
    assert.ok(png.length < 300_000, `${png.length} bytes`);
  });

  it('is the same bytes every build', () => {
    assert.deepEqual(shareImagePng(), png);
  });

  it('is opaque, on the brand blue, with white drawing on it', () => {
    const corner = image.pixel(2, 2);
    assert.equal(corner[3], 255);
    const [r, g, b] = corner;
    const [br, bg, bb] = BRAND;
    assert.ok(Math.abs(r - br) < 24 && Math.abs(g - bg) < 24 && Math.abs(b - bb) < 24, `corner is ${corner}`);
    let white = 0;
    let opaque = true;
    for (let y = 0; y < image.height; y += 5) {
      for (let x = 0; x < image.width; x += 5) {
        const [pr, pg, pb, pa] = image.pixel(x, y);
        if (pa !== 255) opaque = false;
        if (pr > 245 && pg > 245 && pb > 245) white++;
      }
    }
    assert.ok(opaque, 'every pixel is opaque');
    // The wordmark, logo and the card take up a real share of the image, but not most of it.
    const share = white / ((image.width / 5) * (image.height / 5));
    assert.ok(share > 0.08 && share < 0.6, `white share ${share.toFixed(3)}`);
  });
});
