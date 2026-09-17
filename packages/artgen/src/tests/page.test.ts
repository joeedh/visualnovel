/**
 * A page shot's prompt and reviewer spec: what replaces the frame's chunks, what the lettering
 * mode changes, and what a frame keeps — a shot without panels hashes exactly as it did.
 */
import { projectConfig, type PagePanel, type Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { rect } from '../layout.js';
import { buildShotChunks, buildShotPrompt, imageParams, shotInputs, shotSpec } from '../prompts.js';

// Model lettering, which these prompts were written against; the default is the runner's
const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'full-colour manga',
  lettering: 'model',
  models   : { vision: ['gemini', 'claude'] },
});

const aiko = character('aiko', 'approved', 'sha-aiko');
const ren = character('ren', 'approved', 'sha-ren');
const cafe = location('cafe');
const s = scene('s1', ['aiko', 'ren'], 'cafe');
s.lines = [
  { id: 's1:L1', kind: 'narration', text: 'Rain streaks the windows.' },
  { id: 's1:L2', kind: 'dialogue', speaker: 'aiko', text: 'You came.' },
  { id: 's1:L3', kind: 'dialogue', speaker: 'ren', text: 'I said I would.' },
];
const m = model([aiko, ren], [s], [cafe]);

const panels: PagePanel[] = [
  {
    shape      : rect(0, 0, 1, 0.5),
    framing    : 'wide',
    camera     : 'low angle',
    subjects   : [{ characterId: 'aiko', expression: 'startled' }],
    coversLines: ['s1:L1', 's1:L2'],
  },
  {
    shape      : rect(0, 0.5, 1, 0.5),
    framing    : 'close',
    subjects   : [{ characterId: 'ren', pose: 'leaning in' }],
    coversLines: ['s1:L3'],
    artNotes   : 'rain on the glass',
  },
];

function page(over: Partial<Shot> = {}): Shot {
  return {
    id         : 's1__page1',
    sceneId    : 's1',
    framing    : 'wide',
    location   : 'day',
    subjects   : [{ characterId: 'aiko' }, { characterId: 'ren' }],
    camera     : 'ignored on a page',
    coversLines: ['s1:L1', 's1:L2', 's1:L3'],
    panels,
    status: 'pending',
    ...over,
  };
}

describe('a page shot’s prompt', () => {
  it('is the page sentence, one sentence per panel, the lettering and the page scaffolding', () => {
    expect(buildShotPrompt(page(), s, m, config)).toBe(
      'Art style: full-colour manga. ' +
        'A manga page of 2 panels in cafe (day). Layout: panel 1: wide, top row, full width; ' +
        'panel 2: wide, bottom row, full width. ' +
        'Panel 1 (wide shot): AIKO, wearing default, expression: startled. camera: low angle. ' +
        'Panel 2 (close shot): REN, wearing default, pose: leaning in. art direction: rain on the glass. ' +
        'Lettering, verbatim: panel 1: caption "Rain streaks the windows.", AIKO says "You came."; ' +
        'panel 2: REN says "I said I would.". ' +
        'Render as one complete comic page with drawn panel borders; no UI text.',
    );
  });

  it('draws the page wordless under runner lettering, which is the default, and says so', () => {
    const runner = projectConfig.parse({ ...config, lettering: undefined });
    expect(runner.lettering).toBe('runner');
    const prompt = buildShotPrompt(page(), s, m, runner);
    expect(prompt).not.toContain('Lettering');
    expect(prompt).toContain('no text or lettering of any kind.');
  });

  it('keys the chunks by panel index, so an override survives a panel’s words changing', () => {
    const keys = buildShotChunks(page(), s, m, config).map((c) => c.key);
    expect(keys).toEqual(['style', 'page', 'panel-1', 'panel-2', 'lettering', 'scaffolding']);
    const reworded = page({ panels: [{ ...panels[0]!, camera: 'high angle' }, panels[1]!] });
    expect(buildShotChunks(reworded, s, m, config).map((c) => c.key)).toEqual(keys);
    expect(
      buildShotPrompt(page(), s, m, config, {
        mode   : 'chunks',
        replace: { 'panel-2': { text: 'Panel 2: a wordless beat.' } },
      }),
    ).toContain('Panel 2: a wordless beat. Lettering');
  });

  it('casts only the shot’s own subjects, and puts each character’s clothes on every panel', () => {
    const stranger = page({
      panels: [{ ...panels[0]!, subjects: [{ characterId: 'nobody' }, { characterId: 'ren' }] }],
    });
    const prompt = buildShotPrompt(stranger, s, m, config);
    expect(prompt).toContain('Panel 1 (wide shot): REN, wearing default.');
    expect(prompt).not.toContain('nobody');
  });

  it('takes the project’s page aspect unless the page authored its own', () => {
    const base = imageParams(config);
    expect(shotInputs(page(), s, m, config, base, []).params.aspect).toBe('3:4');
    expect(shotInputs(page({ aspect: '2:3' }), s, m, config, base, []).params.aspect).toBe('2:3');
    // A frame that authored none is the very same params object, hashing as it always did.
    const frame = page({ panels: undefined });
    delete frame.panels;
    expect(shotInputs(frame, s, m, config, base, []).params).toBe(base);
  });

  it('re-keys on a lettered line’s text and on which panel letters it', () => {
    const before = buildShotPrompt(page(), s, m, config);
    const retyped = {
      ...s,
      lines: s.lines.map((l) => (l.id === 's1:L3' ? { ...l, text: 'I did.' } : l)),
    };
    expect(buildShotPrompt(page(), retyped, m, config)).not.toBe(before);
    const moved = page({
      panels: [
        { ...panels[0]!, coversLines: ['s1:L1'] },
        { ...panels[1]!, coversLines: ['s1:L2', 's1:L3'] },
      ],
    });
    expect(buildShotPrompt(moved, s, m, config)).not.toBe(before);
  });
});

describe('a page shot’s reviewer spec', () => {
  it('describes the page, lists the panels in words, and letters only when the model did', () => {
    const spec = shotSpec(page(), s, m, 'model');
    expect(spec.description).toContain('A manga page of 2 panel(s) set in day.');
    expect(spec.description).not.toContain('ignored on a page');
    expect(spec.characters).toEqual(['aiko', 'ren']);
    expect(spec.panels).toEqual([
      { index: 1, shapeWords: 'wide, top row, full width', framing: 'wide', characters: ['aiko'] },
      {
        index     : 2,
        shapeWords: 'wide, bottom row, full width',
        framing   : 'close',
        characters: ['ren'],
      },
    ]);
    expect(spec.lettering).toEqual([
      { panel: 1, lines: ['Rain streaks the windows.', 'You came.'] },
      { panel: 2, lines: ['I said I would.'] },
    ]);
    expect(shotSpec(page(), s, m, 'runner').lettering).toBeUndefined();
  });

  it('gives a frame neither key, so its review is what it was', () => {
    const frame = page();
    delete frame.panels;
    const spec = shotSpec(frame, s, m, 'model');
    expect('panels' in spec).toBe(false);
    expect('lettering' in spec).toBe(false);
    expect(spec.description).toContain('A single wide shot set in day.');
  });
});
