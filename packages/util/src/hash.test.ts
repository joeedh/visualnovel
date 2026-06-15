import { canonicalJson, hashParts, sha256 } from './index.js';

describe('sha256', () => {
  it('is stable and hex-encoded', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively so equal inputs serialize identically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe('hashParts', () => {
  it('order-sensitive across parts', () => {
    expect(hashParts('a', 'b')).not.toBe(hashParts('b', 'a'));
  });
});
