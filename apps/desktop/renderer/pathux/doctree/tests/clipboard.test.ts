import { EMPTY_CLIP, clipboard, isCut, onClip, pasted, setClip, type Clip } from '../clipboard.js';

const CUT: Clip = { paths: ['wiki/a.md', 'wiki/lore'], mode: 'cut' };
const COPY: Clip = { paths: ['wiki/a.md'], mode: 'copy' };

describe('pasted', () => {
  it('empties the clipboard after a Cut is pasted, since the paths have moved', () => {
    expect(pasted(CUT)).toBe(EMPTY_CLIP);
  });

  it('keeps a Copy, so the same items can be pasted again', () => {
    expect(pasted(COPY)).toBe(COPY);
  });
});

describe('isCut', () => {
  it('dims only the paths a Cut holds, and nothing a Copy holds', () => {
    expect(isCut(CUT, 'wiki/lore')).toBe(true);
    expect(isCut(CUT, 'wiki/lore/inside.md')).toBe(false);
    expect(isCut(COPY, 'wiki/a.md')).toBe(false);
    expect(isCut(CUT, undefined)).toBe(false);
  });
});

describe('the window clipboard', () => {
  afterEach(() => setClip(EMPTY_CLIP));

  it('starts empty, and tells each listener of a change until it stops listening', () => {
    expect(clipboard()).toEqual(EMPTY_CLIP);
    let heard = 0;
    const off = onClip(() => heard++);
    setClip(CUT);
    off();
    setClip(COPY);
    expect(heard).toBe(1);
    expect(clipboard()).toBe(COPY);
  });
});
