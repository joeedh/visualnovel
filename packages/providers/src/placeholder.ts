/**
 * Deterministic placeholder images for mock runs, and the marker real backends refuse.
 *
 * A mock run used to emit a short text blob with a `.png` extension. That was enough for
 * structure but meant every generated frame rendered broken in the desktop app, so no UI that
 * displays art could be developed or reviewed without spending on a real run. These are real
 * PNGs — solid colour plus a stripe, both derived from the seed, so distinct shots look
 * distinct at thumbnail size.
 *
 * The bytes carry a `tEXt` chunk keyed {@link PLACEHOLDER_KEYWORD}. That is what keeps the
 * old safety net: image backends reject a reference carrying it, so a mock asset still cannot
 * be laundered into a real run — and now the refusal names the actual reason.
 */

/** `tEXt` keyword every placeholder carries. Its presence is the whole detection rule. */
export const PLACEHOLDER_KEYWORD = 'vn-mock-placeholder';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WIDTH = 64;
const HEIGHT = 36;
const STRIPE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let s = 0;
  for (const b of bytes) {
    a = (a + b) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A zlib stream of stored (uncompressed) deflate blocks. Compressing would work too, but
 * zlib's output is only guaranteed stable for a given library version — and these bytes are
 * content-addressed, so the same mock run has to hash the same everywhere.
 */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let off = 0; off < data.length; off += 0xffff) {
    const len = Math.min(0xffff, data.length - off);
    const final = off + len >= data.length ? 1 : 0;
    parts.push(
      new Uint8Array([final, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff]),
      data.subarray(off, off + len),
    );
  }
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler32(data));
  parts.push(trailer);
  return concat(parts);
}

/** Byte `i` of a hex seed, defaulting so a short or odd-length seed still works. */
function seedByte(seed: string, i: number): number {
  const pair = seed.slice(i * 2, i * 2 + 2);
  const v = parseInt(pair, 16);
  return Number.isNaN(v) ? 0 : v;
}

/** A 64×36 PNG whose colours and stripe position derive entirely from `seed` (hex). */
export function placeholderPng(seed: string): Uint8Array {
  const bg = [seedByte(seed, 0), seedByte(seed, 1), seedByte(seed, 2)];
  const fg = bg.map((v) => 255 - v);
  const stripeAt = seedByte(seed, 3) % (WIDTH - STRIPE);

  const stride = 1 + WIDTH * 3;
  const raw = new Uint8Array(HEIGHT * stride);
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < WIDTH; x++) {
      const c = x >= stripeAt && x < stripeAt + STRIPE ? fg : bg;
      const p = row + 1 + x * 3;
      raw[p] = c[0]!;
      raw[p + 1] = c[1]!;
      raw[p + 2] = c[2]!;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, WIDTH);
  view.setUint32(4, HEIGHT);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('tEXt', new TextEncoder().encode(`${PLACEHOLDER_KEYWORD}\0${seed}`)),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * True for bytes produced by {@link placeholderPng}. The marker sits in the first chunk after
 * IHDR, so a short prefix scan finds it; the bound also keeps this cheap on real image bytes.
 */
export function isPlaceholderImage(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 128);
  const keyword = PLACEHOLDER_KEYWORD;
  outer: for (let i = 0; i + keyword.length <= head.length; i++) {
    for (let k = 0; k < keyword.length; k++) {
      if (head[i + k] !== keyword.charCodeAt(k)) continue outer;
    }
    return true;
  }
  return false;
}
