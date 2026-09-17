import { LAYOUT_TEMPLATES, evenLayout } from '@vn/artgen/layout';
import { SITUATIONS } from '../situations/page.js';
import {
  LAYOUTS,
  acceptAction,
  castAction,
  controls,
  defectsOf,
  enterLetters,
  generateAction,
  inLayout,
  layoutAction,
  lineAction,
  pageLines,
  panelOfLine,
  relaid,
  shotCastActions,
  shotCastOf,
  shotModelAction,
  summaryOf,
  verdictOf,
  withCorner,
  withCornerAfter,
  withoutCorner,
  type PageState,
} from '../page.js';
import { keyOf } from '../anchors.js';

const state = (name: string): PageState => SITUATIONS.find((s) => s.name === name)!.state;

/** The page situation with its page laid out in `name`, since the fixture's stacked pair matches no layout. */
const laidOut = (name: string): PageState => {
  const page = state('page');
  const layout = LAYOUTS.find((l) => l.name === name)!;
  return {
    ...page,
    shots: page.shots.map((s) =>
      s.id === page.shotId ? { ...s, panels: relaid(s.panels!, layout.shapes) } : s,
    ),
  };
};

describe('the layout row', () => {
  it('is every named template, then the even layouts from two to six, at their panel counts', () => {
    expect(LAYOUTS.map((l) => l.name)).toEqual([
      ...Object.keys(LAYOUT_TEMPLATES),
      'even-2',
      'even-3',
      'even-4',
      'even-5',
      'even-6',
    ]);
    expect(LAYOUTS.find((l) => l.name === 'even-5')!.shapes).toEqual(evenLayout(5));
  });

  it('refuses the layout the page already sits in, and offers to make a frame a page', () => {
    const page = laidOut('even-2');
    const twoTier = LAYOUTS.find((l) => l.name === 'even-2')!;
    expect(inLayout(state('page').shots[1]!.panels!, twoTier)).toBe(false);
    expect(inLayout(page.shots[1]!.panels!, twoTier)).toBe(true);
    const same = layoutAction(page, twoTier);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.refusal.reason).toContain('already has exactly those panels');

    const frame = state('frame');
    const made = layoutAction(frame, LAYOUTS[0]!);
    expect(made.ok).toBe(true);
    expect(made.tooltip).toMatch(/^Make this frame a page laid out as two tiers of two\./);
    expect(made.tooltip).toContain('is a page now');
    expect(made.tooltip).toContain('in no panel');
  });

  it('keeps a panel’s record through a relayout, and hands a dropped panel’s lines to the last kept', () => {
    const panels = state('page').shots[1]!.panels!;
    const one = relaid(panels, [LAYOUT_TEMPLATES['splash-over-two']![0]!]);
    expect(one).toHaveLength(1);
    expect(one[0]!.coversLines).toEqual(['arrival:L1', 'arrival:L2']);
    expect(one[0]!.framing).toBe('wide');
    const four = relaid(panels, LAYOUT_TEMPLATES['two-tier']!);
    expect(four.map((p) => p.framing)).toEqual(['wide', 'close', 'medium', 'medium']);
    expect(four[1]!.subjects).toEqual([{ characterId: 'aiko' }]);
    expect(four[3]!.coversLines).toEqual([]);
  });
});

describe('the page', () => {
  it('reads the shot’s lines out of the scene in order, and says which panel letters each', () => {
    const page = state('page');
    expect(pageLines(page).map((l) => l.id)).toEqual(['arrival:L1', 'arrival:L2', 'arrival:L3']);
    const panels = page.shots[1]!.panels!;
    expect(panelOfLine(panels, 'arrival:L2')).toBe(1);
    expect(panelOfLine(panels, 'arrival:L3')).toBeNull();
  });

  it('clamps a moved corner to the page, adds one at an edge’s midpoint, and removes one', () => {
    const panels = state('page').shots[1]!.panels!;
    const moved = withCorner(panels, 0, 2, [1.4, -0.2]);
    expect(moved[0]!.shape[2]).toEqual([1, 0]);
    const added = withCornerAfter(panels, 1, 0);
    expect(added[1]!.shape).toHaveLength(5);
    expect(added[1]!.shape[1]).toEqual([0.5, 0.5]);
    expect(withoutCorner(added, 1, 1)[1]!.shape).toEqual(panels[1]!.shape);
  });

  it('letters a line in the selected panel on Enter, and in none when no panel is selected', () => {
    expect(enterLetters(state('page'), 'arrival:L3')).toBeNull();
    const panels = enterLetters(state('panel-selected'), 'arrival:L1')!;
    expect(panels.map((p) => p.coversLines)).toEqual([[], ['arrival:L2', 'arrival:L1']]);
  });

  it('refuses a line row on a frame, naming the way out', () => {
    const frame = state('frame');
    const row = lineAction(frame, frame.lines[0]!);
    expect(row.ok).toBe(false);
    if (!row.ok) expect(row.refusal.reason).toContain('pick a layout');
  });

  it('toggles a cast member in or out of the selected panel, each way priced by the rule', () => {
    const selected = state('panel-selected');
    const out = castAction(selected, 'aiko');
    expect(out.tooltip).toMatch(/^Take aiko out of panel 2\./);
    const into = castAction(selected, 'ren');
    expect(into.tooltip).toMatch(/^Put ren in panel 2\./);
    expect(into.tooltip).toContain('drawn again');
  });

  it('says one sentence about the render: not drawn, the layout verdict, or nothing', () => {
    const page = state('page').shots[1]!;
    expect(verdictOf({ ...page, image: undefined })).toBe('Not drawn yet');
    expect(verdictOf(page)).toBe('');
    expect(verdictOf({ ...page, layout: 'Panel 2 came out short.' })).toBe(
      'Panel 2 came out short.',
    );
    expect(summaryOf(page)).toBe('3:4 · 2 panels');
    expect(summaryOf(laidOut('diagonal-split').shots[1])).toBe('diagonal-split · 3:4 · 2 panels');
    expect(summaryOf(state('frame').shots[0])).toBe('16:9 · single frame');
  });

  it('says what the reviewers or the pipeline held against a render, and lists the defects', () => {
    const page = state('flagged').shots[1]!;
    expect(verdictOf(page)).toContain('reviewers kept blocking it');
    expect(defectsOf(page)).toEqual(['Panel 2 shows ren, who is not in it.']);
    const failed = {
      ...page,
      failure: { task: 't1', status: 'failed' as const, error: 'boom', defects: [] },
    };
    expect(verdictOf(failed)).toBe('The pipeline failed on it: boom');
    expect(defectsOf(state('page').shots[1])).toEqual([]);
  });
});

describe('the head’s actions', () => {
  it('generates the shot on screen through pipeline.draw, and reads Regenerate once drawn', () => {
    expect(generateAction(state('page'))).toMatchObject({
      ok   : true,
      id   : 'pipeline.draw',
      props: { slot: 'shot:arrival/arrival__page1' },
      label: 'Regenerate',
    });
    expect(generateAction(state('frame'))).toMatchObject({
      ok     : false,
      label  : 'Generate',
      refusal: { reason: expect.stringContaining('has not been rendered') },
    });
    expect(generateAction(state('no-shot')).ok).toBe(false);
  });

  it('accepts only a render waiting on a human, by its hash', () => {
    expect(acceptAction(state('flagged'))).toMatchObject({
      ok   : true,
      id   : 'asset.accept',
      props: { hash: 'a1b2c3d4' },
    });
    expect(acceptAction(state('page')).ok).toBe(false);
    expect(acceptAction(state('no-shot')).ok).toBe(false);
  });

  it('sets the shot’s own image model, the select supplying it', () => {
    expect(shotModelAction(state('page'))).toMatchObject({
      ok      : true,
      id      : 'art.setModel',
      props   : { target: 'shot:arrival/arrival__page1' },
      supplies: ['model'],
    });
    expect(shotModelAction(state('page')).tooltip).toContain('mock-image');
    expect(shotModelAction(state('no-shot')).ok).toBe(false);
  });

  it('reads the shot’s cast the way Shot Coverage does, and offers the same controls', () => {
    expect(shotCastOf(state('page'))).toMatchObject({
      scene       : 'arrival',
      shot        : 'arrival__page1',
      framed      : ['aiko', 'ren'],
      spare       : ['sato'],
      projectModel: 'mock-image',
    });
    const keys = shotCastActions(state('page')).map(keyOf);
    expect(keys).toEqual([
      'cmd:story.setSubjects#drop/aiko',
      'cmd:story.setSubjects#drop/ren',
      'cmd:story.setSubjects#add',
    ]);
    expect(shotCastOf(state('no-shot'))).toBeUndefined();
    expect(shotCastActions(state('no-shot'))).toEqual([]);
  });
});

describe('controls', () => {
  it('draws nothing with no shot, and no corner or field until a panel is selected', () => {
    expect(controls(state('no-shot'))).toEqual([]);
    const page = controls(state('page')).map(keyOf);
    expect(page.some((k) => k.includes('#corner/'))).toBe(false);
    expect(page.some((k) => k.includes('/framing'))).toBe(false);
    expect(page.filter((k) => k.startsWith('fx:pane.view#panel/'))).toHaveLength(2);
    expect(page.filter((k) => k.startsWith('fx:drag.start#line/'))).toHaveLength(3);
  });

  it('draws Generate and the model on every shot, and Accept only on a flagged one', () => {
    const page = controls(state('page')).map(keyOf);
    expect(page).toContain('cmd:pipeline.draw');
    expect(page).toContain('cmd:art.setModel');
    expect(page).not.toContain('cmd:asset.accept');
    expect(controls(state('flagged')).map(keyOf)).toContain('cmd:asset.accept');
  });

  it('draws the selected panel’s corners, its fields, and pose and expression for who is in it', () => {
    const keys = controls(state('panel-selected')).map(keyOf);
    expect(keys.filter((k) => k.includes('#corner/2/'))).toHaveLength(4);
    expect(keys).toContain('cmd:story.setPanels#panel/2/framing');
    expect(keys).toContain('cmd:story.setPanels#panel/2/cast/aiko/pose');
    expect(keys).not.toContain('cmd:story.setPanels#panel/2/cast/ren/pose');
    expect(keys).toContain('cmd:story.setPanels#panel/2/notes');
  });

  it('keys every control apart', () => {
    for (const situation of SITUATIONS) {
      const keys = controls(situation.state).map(keyOf);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
