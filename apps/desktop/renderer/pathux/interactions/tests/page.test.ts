import { panelTarget } from '../../../../src/shared/interactions.js';
import { aimLine, grabLine, letterNotice } from '../page.js';
import type { CoverageLine, CoverageShot, SceneCoverage } from '../../../../src/shared/ipc';

const LINES: CoverageLine[] = [
  { id: 's:L1', kind: 'narration', text: 'The roof, at dusk.' },
  { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'Um… hello.' },
  { id: 's:L3', kind: 'dialogue', speaker: 'ren', text: 'You came.' },
];

const half = (y0: number, y1: number): [number, number][] => [
  [0, y0],
  [1, y0],
  [1, y1],
  [0, y1],
];

const PAGE: CoverageShot = {
  id         : 's__page',
  framing    : 'wide',
  subjects   : ['aiko'],
  location   : 'day',
  outfits    : {},
  coversLines: ['s:L1', 's:L2', 's:L3'],
  panels: [
    { shape: half(0, 0.5), framing: 'wide', subjects: [], coversLines: ['s:L1'] },
    { shape: half(0.5, 1), framing: 'close', subjects: [], coversLines: ['s:L2', 's:L3'] },
  ],
  aspect     : '3:4',
  status     : 'accepted',
  drift      : 'current',
};

const data: SceneCoverage = {
  sceneId    : 's',
  location   : 'roof',
  heading    : 'EXT. ROOF - NIGHT',
  lines      : LINES,
  shots      : [PAGE],
  cast       : [],
  characters : [],
  variants   : ['day'],
  decomposed : true,
  lettering  : 'model',
  bubbleNames: false,
  names      : {},
  imageModel : 'mock-image',
};

describe('the letter drag', () => {
  it('judges every panel at the grab and starts aimed at nothing', () => {
    const letter = grabLine(data, 's__page', 's:L2');
    expect([...letter.verdicts.keys()]).toEqual([panelTarget(0), panelTarget(1)]);
    expect(letter.panel).toBeNull();
    expect(letter.verdict).toBeNull();
    expect(letterNotice(letter)).toBeNull();
  });

  it('reads the aimed panel’s verdict off, previewing an accept and saying why a refusal refuses', () => {
    const letter = grabLine(data, 's__page', 's:L2');
    const moved = aimLine(letter, 0);
    expect(moved.verdict?.accept).toBe(true);
    expect(letterNotice(moved)).toEqual({
      tone: 'preview',
      text: expect.stringContaining('drawn again'),
    });
    const same = aimLine(letter, 1);
    expect(letterNotice(same)).toEqual({ tone: 'refused', text: 'Panel 2 already letters s:L2.' });
    expect(aimLine(same, null).verdict).toBeNull();
  });

  it('holds no verdicts for a shot the scene lacks, so no panel ever accepts', () => {
    const letter = grabLine(data, 's__gone', 's:L2');
    expect(aimLine(letter, 0).verdict).toBeNull();
  });
});
