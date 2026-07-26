import { inflateSync } from 'node:zlib';
import { PLACEHOLDER_KEYWORD, isPlaceholderImage, placeholderPng } from '../placeholder.js';

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
}

/** Walk the chunk list. Reaching the end exactly is itself the check on every length field. */
function chunks(png: Uint8Array): Chunk[] {
  const buf = Buffer.from(png);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out: Chunk[] = [];
  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    out.push({
      type: buf.subarray(at + 4, at + 8).toString('latin1'),
      data: buf.subarray(at + 8, at + 8 + len),
      crc: buf.readUInt32BE(at + 8 + len),
    });
    at += 12 + len;
  }
  expect(at).toBe(buf.length);
  return out;
}

describe('placeholderPng', () => {
  it('is a well-formed 64x36 truecolour PNG', () => {
    const parts = chunks(placeholderPng('0011223344556677'));
    expect(parts.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);

    const ihdr = parts[0]!.data;
    expect(ihdr.readUInt32BE(0)).toBe(64);
    expect(ihdr.readUInt32BE(4)).toBe(36);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(2); // truecolour
    // The one CRC with a universally known value; pins the crc32 table.
    expect(parts[3]!.crc).toBe(0xae426082);
  });

  it('carries the marker chunk and the seed that produced it', () => {
    const [, text] = chunks(placeholderPng('0011223344556677'));
    expect(text!.data.toString('latin1')).toBe(`${PLACEHOLDER_KEYWORD}\0` + '0011223344556677');
  });

  it('holds a zlib stream node can inflate, whose pixels come from the seed', () => {
    // Hand-rolled stored-deflate blocks and adler32: inflating with a real implementation is
    // the only check that says so. inflateSync validates the checksum too.
    const [, , idat] = chunks(placeholderPng('0011223344556677'));
    const raw = inflateSync(idat!.data);
    const stride = 1 + 64 * 3;
    expect(raw.length).toBe(36 * stride);
    for (let y = 0; y < 36; y++) expect(raw[y * stride]).toBe(0); // filter: none

    // seed bytes 0..2 are the background; the stripe starts at 0x33 % 56 = 51.
    expect([...raw.subarray(1, 4)]).toEqual([0x00, 0x11, 0x22]);
    const stripe = 1 + 51 * 3;
    expect([...raw.subarray(stripe, stripe + 3)]).toEqual([255, 238, 221]);
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(
      Buffer.from(placeholderPng('abc123')).equals(Buffer.from(placeholderPng('abc123'))),
    ).toBe(true);
    expect(
      Buffer.from(placeholderPng('abc123')).equals(Buffer.from(placeholderPng('abc124'))),
    ).toBe(false);
  });

  it('tolerates a short or non-hex seed rather than emitting a corrupt file', () => {
    expect(chunks(placeholderPng('')).map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(chunks(placeholderPng('zz')).map((c) => c.type)).toEqual([
      'IHDR',
      'tEXt',
      'IDAT',
      'IEND',
    ]);
  });
});

describe('isPlaceholderImage', () => {
  it('recognizes its own output', () => {
    expect(isPlaceholderImage(placeholderPng('deadbeef'))).toBe(true);
  });

  it('passes real image bytes and short junk through', () => {
    const realPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200, 0x7f),
    ]);
    expect(isPlaceholderImage(realPng)).toBe(false);
    expect(isPlaceholderImage(new Uint8Array())).toBe(false);
    expect(isPlaceholderImage(new TextEncoder().encode('vn-mock'))).toBe(false);
  });
});
