/**
 * The fold over a fresh `model()`, run in-process the way `model.test.ts` runs the driver, over
 * a fixture doc index: the registry lives in main, and the renderer's typecheck does not reach
 * it, so the command half (every registry command has a page, the golden pages) is
 * `src/main/tests/uxdocs.test.ts`'s. Nothing here reads `dist/`. The counts are stated so a
 * rules change that moves them is noticed here rather than in the tree nobody diffs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toEffectCatalog, toInteractionCatalog, type DocCommandEntry } from '@vn/commands';
import { model } from '../model.js';
import { createDesktopEffects, EFFECT_IDS } from '../../../src/shared/effects.js';
import { createDesktopInteractions } from '../../../src/shared/interactions.js';
import { actionsOf, type UxModel } from '../../../src/shared/uxmodel.js';
import { fold, UX_ANCHORS, UX_DOCS, type UxPage } from '../../../src/shared/uxdocs.js';

const file = model();
const anchors = UX_ANCHORS.parse(
  JSON.parse(readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8')),
);
const effects = toEffectCatalog(createDesktopEffects());
const interactions = toInteractionCatalog(createDesktopInteractions());

/** A doc index naming every command the model reaches, with nothing but an id and a title. */
function fixtureDocs(of: UxModel): DocCommandEntry[] {
  const ids = new Set(
    of.records
      .flatMap((r) => actionsOf(r).map((a) => a.id))
      .filter((id) => !EFFECT_IDS.includes(id)),
  );
  return [...ids].sort().map((id) => ({
    id,
    namespace  : id.split('.')[0]!,
    title      : id,
    description: `Runs ${id}.`,
    mutating   : false,
    confirm    : false,
    undoable   : false,
    checkable  : false,
    props      : [],
  }));
}

const entries = fixtureDocs(file);
const docs = fold(file, anchors, entries, interactions, effects);
const byId = new Map<string, UxPage>([...docs.commands, ...docs.effects].map((p) => [p.id, p]));

/** Every refusal sentence in the model, with the first-action ids of the records carrying it. */
function refusalsInModel(): Map<string, Set<string>> {
  const said = new Map<string, Set<string>>();
  for (const record of file.records) {
    const sentence =
      record.via === 'control'
        ? record.offer.ok
          ? undefined
          : record.offer.refusal.reason
        : record.refused;
    if (sentence === undefined) continue;
    const ids = said.get(sentence) ?? new Set<string>();
    ids.add(actionsOf(record)[0]!.id);
    said.set(sentence, ids);
  }
  return said;
}

describe('fold', () => {
  it('parses under UX_DOCS', () => {
    expect(() => UX_DOCS.parse(docs)).not.toThrow();
  });

  it('gives every command of the index and every effect a page', () => {
    expect(docs.commands.map((p) => p.id)).toEqual(entries.map((e) => e.id));
    expect(docs.effects.map((p) => p.id).sort()).toEqual([...EFFECT_IDS].sort());
    for (const page of docs.commands) expect(page.doc?.id).toBe(page.id);
    for (const page of docs.effects) expect(page.effect?.id).toBe(page.id);
  });

  it('puts each refusal sentence on exactly the pages whose first action carries it', () => {
    const expected = refusalsInModel();
    expect(expected.size).toBe(99);
    const found = new Map<string, Set<string>>();
    for (const page of byId.values()) {
      for (const refusal of page.refused) {
        const ids = found.get(refusal.says) ?? new Set<string>();
        ids.add(page.id);
        found.set(refusal.says, ids);
      }
    }
    const asLists = (map: Map<string, Set<string>>) =>
      [...map].map(([says, ids]) => [says, [...ids].sort()]).sort();
    expect(asLists(found)).toEqual(asLists(expected));
  });

  it('keeps the stack stamp on a refusal worded by the stack', () => {
    const stamped = file.records.find((r) => r.via === 'control' && r.reasonFrom === 'stack');
    expect(stamped).toBeDefined();
    const page = byId.get(actionsOf(stamped!)[0]!.id)!;
    expect(page.refused.some((r) => r.reasonFrom === 'stack')).toBe(true);
  });

  it('folds the model to a stated number of drawn rows', () => {
    const drawn = [...byId.values()].reduce((n, page) => n + page.drawn.length, 0);
    expect(drawn).toBe(518);
    // Every accepted control lands on its page under its own situation; twins in one situation
    // (the page editor's four corners) fold into one row
    for (const record of file.records) {
      if (record.via !== 'control' || !record.offer.ok) continue;
      const page = byId.get(record.effects[0]!.id)!;
      const own = page.drawn.filter(
        (row) =>
          row.editor === record.editor &&
          row.module === record.module &&
          row.label === record.offer.label &&
          row.situations.includes(record.situation),
      );
      expect(own.length).toBeGreaterThan(0);
    }
  });

  it('folds rows that differ only by situation into one', () => {
    const pin = byId.get('pane.pin')!;
    const script = pin.drawn.filter((row) => row.editor === 'script');
    expect(script.map((row) => row.situations)).toEqual([['following'], ['pinned']]);
    const open = byId.get('view.open')!.drawn.find((row) => row.module === 'headerbar');
    expect(open?.situations.length).toBeGreaterThan(1);
  });

  it('lists a then action once on its own page under reached after', () => {
    const tree = file.records.find(
      (r) => r.via === 'control' && r.module === 'documents' && r.effects.length > 1,
    );
    expect(tree).toBeDefined();
    const [first, second] = actionsOf(tree!);
    const later = byId.get(second!.id)!;
    const rows = later.reachedAfter.filter(
      (row) =>
        row.editor === tree!.editor &&
        row.module === 'documents' &&
        row.situation === tree!.situation &&
        row.first === first!.id,
    );
    expect(rows).toHaveLength(1);
    // And the row itself lives on the first action's page, carrying the later id in `then`
    const owner = byId.get(first!.id)!;
    expect(owner.drawn.some((row) => row.then.includes(second!.id))).toBe(true);
    for (const page of byId.values()) {
      const keys = page.reachedAfter.map((row) => JSON.stringify(row));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('lists a menu entry on the page of what it runs, refused or not', () => {
    const entry = file.records.find((r) => r.via === 'menu' && r.refused !== undefined);
    expect(entry).toBeDefined();
    const page = byId.get(actionsOf(entry!)[0]!.id)!;
    expect(page.menus.some((m) => m.when === (entry as { when: string }).when)).toBe(true);
    expect(page.refused.some((r) => r.says === (entry as { refused: string }).refused)).toBe(true);
  });

  it('reads the sweep bit and the palette-only rule as two facts', () => {
    const swept = byId.get('gate.approve')!;
    expect(swept.anchored).toBe(true);
    expect(swept.paletteOnly).toBeUndefined();
    expect(docs.swept).toEqual({ at: anchors.sweptAt, sha: anchors.gitSha });
    const rule = file.paletteOnly.find((entry) => !entry.match.includes('*'))!;
    const routed = fold(
      file,
      anchors,
      [...entries, { ...entries[0]!, id: rule.match }],
      interactions,
      effects,
    );
    expect(routed.commands.find((p) => p.id === rule.match)?.paletteOnly).toBe(rule.why);
  });

  it('stamps a shortcut on the page of what it runs', () => {
    expect(byId.get('gengraph.createGroup')!.shortcuts).toEqual(['Ctrl+G (gengraph)']);
    expect(byId.get('popup.open')!.shortcuts).toContain('Ctrl+Shift+P');
  });

  it('lists every editor with every module and situation of the model', () => {
    const listed = docs.editors.flatMap((home) =>
      home.modules.flatMap((mod) =>
        mod.situations.map((s) => `${home.id} ${mod.module} ${s.name}`),
      ),
    );
    expect(listed.sort()).toEqual(
      file.situations.map((s) => `${s.editor} ${s.module} ${s.name}`).sort(),
    );
    expect(docs.situations.map((m) => m.module).sort()).toEqual(
      [...new Set(file.situations.map((s) => s.module))].sort(),
    );
    const header = docs.situations.find((m) => m.module === 'headerbar')!;
    const run = header.controls.find((c) => c.key === 'cmd:pipeline.run')!;
    expect(run.verdicts).toMatchObject({ idle: 'ok', running: 'refused' });
  });

  it('refuses a record whose first action names nothing', () => {
    const broken = {
      ...file,
      records: [
        {
          ...file.records.find((r) => r.via === 'control')!,
          effects: [{ id: 'pane.vanish', props: {} }],
        },
      ],
    };
    expect(() => fold(broken as typeof file, anchors, entries, interactions, effects)).toThrow(
      /pane\.vanish/,
    );
  });
});
