import { assetOpener, lineOpener } from '../agentseed.js';
import type { AssetFailure, AssetInfo, SceneCoverage } from '../ipc.js';

const scene: SceneCoverage = {
  sceneId: 'cafe_night',
  location: 'cafe',
  heading: 'INT. CAFÉ MORI - NIGHT',
  lines: [
    { id: 's:L1', kind: 'narration', text: 'Rain on the window.' },
    { id: 's:L2', kind: 'dialogue', speaker: 'aiko', text: 'I told you not to come.' },
  ],
  shots: [],
  cast: [],
  characters: [],
  variants: [],
  decomposed: true,
};

function failed(over: Partial<AssetFailure> = {}): AssetFailure {
  return { task: 't1', status: 'failed', attempts: 3, maxAttempts: 3, later: false, ...over };
}

function info(over: Partial<AssetInfo> = {}): AssetInfo {
  return {
    hash: 'abc123',
    ext: 'png',
    kind: 'location_ref',
    label: 'Café Mori — night',
    base: true,
    accepted: false,
    sourceTask: 't1',
    stale: false,
    prereqs: [],
    rungs: [],
    ...over,
  };
}

describe('lineOpener', () => {
  it('carries the number the author clicked, the id a refusal names, and the words', () => {
    expect(lineOpener(scene, 's:L2')).toBe(
      'In scene cafe_night, line 2 (s:L2) — “aiko: I told you not to come.” — ',
    );
  });

  it('quotes a line nobody speaks without inventing a speaker', () => {
    expect(lineOpener(scene, 's:L1')).toContain('“Rain on the window.”');
  });

  // The composer is one line, so a long speech cannot arrive with its own newlines in it
  it('flattens and cuts a long line', () => {
    const long = { ...scene.lines[1]!, text: `${'word '.repeat(40)}\nend` };
    const opener = lineOpener({ ...scene, lines: [scene.lines[0]!, long] }, 's:L2');
    expect(opener).not.toContain('\n');
    expect(opener).toContain('…');
  });

  it('opens nothing for a line the scene no longer holds', () => {
    expect(lineOpener(scene, 's:L9')).toBe('');
  });
});

describe('assetOpener', () => {
  it('names the slot, the budget it spent and what it recorded', () => {
    expect(
      assetOpener(info({ slot: 'plate:cafe/night', failure: failed({ error: 'HTTP 400' }) })),
    ).toBe(
      '“Café Mori — night” (plate:cafe/night) failed after 3 of 3 attempts — HTTP 400. Work out ' +
        'what in its prompt or its art notes caused that, and propose a change.',
    );
  });

  // The attempts a refine pass records are not tries against the retry budget, so quoting the
  // budget here would report a frame reviewed three times as having been tried three times
  it('counts no attempts for a frame review kept blocking', () => {
    const opener = assetOpener(
      info({ failure: failed({ status: 'needs_human', error: 'off-model' }) }),
    );
    expect(opener).toContain('was drawn, and review kept blocking it — off-model');
    expect(opener).not.toContain('attempts');
  });

  it('says when the failure is a re-render rather than the picture on screen', () => {
    expect(assetOpener(info({ failure: failed({ later: true }) }))).toContain(
      'The re-render of “Café Mori — night” failed after 3 of 3 attempts.',
    );
  });

  it('opens nothing for an asset that has not failed', () => {
    expect(assetOpener(info())).toBe('');
  });
});
