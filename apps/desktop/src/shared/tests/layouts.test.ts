import { EDITOR_IDS } from '../editors.js';
import {
  DEFAULT_LAYOUT,
  DEFAULT_RECIPE,
  LAYOUT_ATTRIBUTE,
  LAYOUT_FORMAT,
  SHIPPED_LAYOUTS,
  isConflicted,
  layoutSlug,
  parseLayoutFile,
  recipeEditors,
  recipeProblem,
  serializeLayoutFile,
  shippedLayoutFile,
  shippedLayoutFiles,
  type LayoutRecipe,
} from '../layouts.js';

describe('layoutSlug', () => {
  it('makes a filename out of a title', () => {
    expect(layoutSlug('Writing')).toBe('writing');
    expect(layoutSlug('My Desk')).toBe('my_desk');
    expect(layoutSlug('  Art / Review  ')).toBe('art_review');
    expect(layoutSlug('Act 2: the fall')).toBe('act_2_the_fall');
  });

  it('collapses a name with nothing sluggable in it to empty, rather than guessing', () => {
    expect(layoutSlug('///')).toBe('');
    expect(layoutSlug('')).toBe('');
  });
});

describe('recipeProblem', () => {
  it('accepts every shipped recipe', () => {
    for (const shipped of SHIPPED_LAYOUTS) {
      expect(recipeProblem(shipped.recipe)).toBeUndefined();
    }
  });

  it('refuses a split that falls outside the area it divides', () => {
    const at = (value: number): LayoutRecipe => ({
      split: 'columns',
      at: value,
      first: { pane: ['script'] },
      second: { pane: ['convo'] },
    });
    expect(recipeProblem(at(0))).toMatch(/inside the area/);
    expect(recipeProblem(at(1))).toMatch(/inside the area/);
    expect(recipeProblem(at(-0.5))).toMatch(/inside the area/);
    expect(recipeProblem(at(0.5))).toBeUndefined();
  });

  it('refuses an editor this build has not got, by name', () => {
    expect(recipeProblem({ pane: ['nosuch'] })).toBe('there is no nosuch editor in this build');
  });

  it('refuses an empty pane and a split into neither columns nor rows', () => {
    expect(recipeProblem({ pane: [] })).toMatch(/at least one editor/);
    expect(
      recipeProblem({
        split: 'diagonal',
        at: 0.5,
        first: { pane: ['script'] },
        second: { pane: ['convo'] },
      }),
    ).toMatch(/columns or rows/);
  });

  it('reaches into a nested branch', () => {
    expect(
      recipeProblem({
        split: 'columns',
        at: 0.5,
        first: { pane: ['script'] },
        second: {
          split: 'rows',
          at: 0.5,
          first: { pane: ['convo'] },
          second: { pane: ['nosuch'] },
        },
      }),
    ).toBe('there is no nosuch editor in this build');
  });
});

describe('the shipped layouts', () => {
  it('have unique slugs and name only editors this build has', () => {
    const slugs = SHIPPED_LAYOUTS.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const shipped of SHIPPED_LAYOUTS) {
      for (const id of recipeEditors(shipped.recipe)) expect(EDITOR_IDS).toContain(id);
    }
  });

  it('start with the one the shell builds when it has nothing remembered', () => {
    expect(SHIPPED_LAYOUTS[0]?.slug).toBe(DEFAULT_LAYOUT);
    expect(SHIPPED_LAYOUTS[0]?.recipe).toBe(DEFAULT_RECIPE);
  });

  // A regression pin on the arrangement the app has always booted into. `splitArea`'s fraction
  // is of the area being divided, so the nesting — not the numbers — is what puts Documents at
  // 18% rather than 30%; changing either without meaning to would go unnoticed otherwise.
  it('put Writing where the shell has always built it', () => {
    expect(recipeEditors(DEFAULT_RECIPE)).toEqual(['documents', 'script', 'branches', 'convo']);
    expect(flatten(DEFAULT_RECIPE)).toEqual([
      { editors: ['documents'], from: 0, to: 0.18 },
      { editors: ['script', 'branches'], from: 0.18, to: 0.6 },
      { editors: ['convo'], from: 0.6, to: 1 },
    ]);
  });
});

/** Where a column recipe's panes land across the window, the way `splitArea` nests them. */
function flatten(
  node: LayoutRecipe,
  from = 0,
  to = 1,
): { editors: string[]; from: number; to: number }[] {
  if ('pane' in node) return [{ editors: [...node.pane], from: round(from), to: round(to) }];
  const cut = from + (to - from) * node.at;
  return [...flatten(node.first, from, cut), ...flatten(node.second, cut, to)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe('parseLayoutFile', () => {
  const good = shippedLayoutFile('writing')!;

  it('round-trips a shipped layout', () => {
    const parsed = parseLayoutFile(serializeLayoutFile(good));
    expect(parsed.ok && parsed.file).toEqual(good);
  });

  it('round-trips a saved screen blob', () => {
    const saved = {
      ...good,
      source: 'saved' as const,
      recipe: undefined,
      screen: { magic: 'VNSC', a: 1 },
    };
    delete (saved as { recipe?: unknown }).recipe;
    const parsed = parseLayoutFile(serializeLayoutFile(saved));
    expect(parsed.ok && parsed.file.screen).toEqual({ magic: 'VNSC', a: 1 });
    expect(parsed.ok && parsed.file.source).toBe('saved');
  });

  // Notepad and PowerShell both write one, and a template is a file authors edit by hand.
  it('reads a file a Windows editor left a BOM on', () => {
    const parsed = parseLayoutFile(`\uFEFF${serializeLayoutFile(good)}`);
    expect(parsed.ok && parsed.file).toEqual(good);
  });

  it('refuses text that is not JSON, and an object that is not a template', () => {
    expect(parseLayoutFile('not json')).toEqual({
      ok: false,
      problem: expect.stringContaining('not valid JSON'),
    });
    expect(parseLayoutFile('[]')).toEqual({ ok: false, problem: 'it is not a layout template' });
  });

  it('refuses a format it does not know, by name', () => {
    const text = JSON.stringify({ ...good, vnstudio: 'layout/2' });
    expect(parseLayoutFile(text)).toEqual({
      ok: false,
      problem: `it is in the layout/2 format, not ${LAYOUT_FORMAT}`,
    });
  });

  it('refuses a file holding both arrangements, and one holding neither', () => {
    expect(parseLayoutFile(JSON.stringify({ ...good, screen: {} }))).toEqual({
      ok: false,
      problem: expect.stringContaining('both a recipe and a saved screen'),
    });
    const neither = { ...good } as Record<string, unknown>;
    delete neither.recipe;
    expect(parseLayoutFile(JSON.stringify(neither))).toEqual({
      ok: false,
      problem: 'it holds neither a recipe nor a saved screen',
    });
  });

  it('refuses a template naming an editor this build has not got', () => {
    const stale = { ...good, editors: ['documents', 'holodeck'] };
    expect(parseLayoutFile(JSON.stringify(stale))).toEqual({
      ok: false,
      problem: 'it uses the holodeck editor(s), which this build has not got',
    });
  });

  it('refuses a file a merge left both sides in, before trying to read it', () => {
    const text = [
      '<<<<<<< HEAD',
      JSON.stringify(good),
      '=======',
      JSON.stringify(good),
      '>>>>>>> theirs',
    ].join('\n');
    expect(isConflicted(text)).toBe(true);
    expect(parseLayoutFile(text)).toEqual({
      ok: false,
      problem: expect.stringContaining('pick a side'),
    });
  });

  it('does not mistake ordinary prose for a conflict', () => {
    expect(isConflicted(JSON.stringify(good))).toBe(false);
    expect(isConflicted('a <<<<<<<-shaped thing mid-line')).toBe(false);
  });
});

describe('shippedLayoutFiles', () => {
  it('names one file per shipped layout, under the layouts directory', () => {
    expect(shippedLayoutFiles().map((file) => file.path)).toEqual([
      '.vnstudio/layouts/writing.json',
      '.vnstudio/layouts/art.json',
    ]);
  });

  // Reset writes these bytes every time it runs. If they carried a timestamp, a reset that
  // changed nothing would still dirty the worktree and look like one that did.
  it('is byte-stable across calls', () => {
    expect(shippedLayoutFiles()).toEqual(shippedLayoutFiles());
  });

  it('declares the merge policy git needs', () => {
    expect(LAYOUT_ATTRIBUTE).toBe('.vnstudio/layouts/*.json text eol=lf -merge');
  });
});
