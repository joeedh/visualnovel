/**
 * The command half of the UX docs tree: the fold over the committed `ux-model.json` with the live
 * registry, and the pages it renders. The model is read as JSON here for the reason
 * `uxmodel.test.ts` reads it, and `renderer/rules/tests/model.test.ts` is what keeps that file
 * equal to a fresh `model()`; the structural half of the fold is `renderer/rules/tests/uxdocs.test.ts`.
 * Nothing here reads `dist/`.
 *
 * Golden pages are under `__fixtures__/uxdocs/`; `UPDATE_GOLDEN=1 pnpm exec jest uxdocs`
 * rewrites them after a deliberate change to the renderer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { uxCatalogs, uxPages } from '../commands/uxdocs-entry.js';
import { EFFECT_IDS } from '../../shared/effects.js';
import { UX_MODEL } from '../../shared/uxmodel.js';
import { fold, pagePath, render, UX_ANCHORS, type UxPage } from '../../shared/uxdocs.js';

const model = UX_MODEL.parse(
  JSON.parse(readFileSync(resolve(__dirname, '../../../ux-model.json'), 'utf8')),
);
const anchors = UX_ANCHORS.parse(
  JSON.parse(readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8')),
);
const { docs: entries, interactions, effects } = uxCatalogs();
const docs = fold(model, anchors, entries, interactions, effects);
const pages = render(docs);
const byId = new Map<string, UxPage>([...docs.commands, ...docs.effects].map((p) => [p.id, p]));

const GOLDEN = resolve(__dirname, '__fixtures__', 'uxdocs');

const golden = (name: string, text: string) => {
  const path = resolve(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, 'utf8'));
};

describe('fold, with the registry', () => {
  it('gives every registry command and every effect a page', () => {
    expect(docs.commands.map((p) => p.id).sort()).toEqual(entries.map((e) => e.id).sort());
    expect(docs.effects.map((p) => p.id).sort()).toEqual([...EFFECT_IDS].sort());
  });

  it('opens a page with the doc entry, notes included', () => {
    const page = byId.get('gate.approve')!;
    expect(page.doc?.notes).toBeDefined();
    expect(page.doc?.checkable).toBe(true);
  });

  it('gives a command with no records the props and the palette-only rule', () => {
    const routed = byId.get('tour.cancel')!;
    expect(routed.drawn).toEqual([]);
    expect(routed.refused).toEqual([]);
    expect(routed.menus).toEqual([]);
    expect(routed.anchored).toBe(false);
    expect(routed.paletteOnly).toBeDefined();
  });
});

describe('render', () => {
  it('writes one page per command, effect, editor, module and interaction', () => {
    const paths = [...pages.keys()];
    expect(paths).toContain('README.md');
    expect(paths).toContain('shortcuts.md');
    for (const page of docs.commands) expect(paths).toContain(pagePath(page));
    for (const page of docs.effects) expect(paths).toContain(`effects/${page.id}.md`);
    for (const home of docs.editors) expect(paths).toContain(`editors/${home.id}.md`);
    for (const mod of docs.situations) expect(paths).toContain(`situations/${mod.module}.md`);
    for (const entry of docs.interactions) {
      expect(paths).toContain(`interactions/${entry.id}.md`);
    }
    expect(pagePath({ id: 'story.setCoverage', kind: 'command' })).toBe(
      'commands/story/setCoverage.md',
    );
  });

  it('is what the generator entry writes', () => {
    expect(uxPages(model, anchors)).toEqual(pages);
  });

  it('escapes a pipe inside a cell, and nothing else', () => {
    const page = byId.get('gate.approve')!;
    const piped: UxPage = {
      ...page,
      drawn: [{ ...page.drawn[0]!, tooltip: 'Approve it | or not', label: "Aiko's" }],
    };
    const text = render({ ...docs, commands: [piped], effects: [] }).get(pagePath(page))!;
    expect(text).toContain("| Aiko's | Approve it \\| or not |");
  });

  it('matches the golden page for a command with refusals', () => {
    golden('gate.approve.md', pages.get('commands/gate/approve.md')!);
  });

  it('matches the golden page for a command with no records', () => {
    golden('tour.cancel.md', pages.get('commands/tour/cancel.md')!);
  });

  it('matches the golden page for an effect', () => {
    golden('pane.pin.md', pages.get('effects/pane.pin.md')!);
  });

  it('matches the golden page for an editor', () => {
    golden('approvals.md', pages.get('editors/approvals.md')!);
  });
});
