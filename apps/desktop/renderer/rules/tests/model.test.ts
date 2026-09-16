import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { duplicateKeys, keyOf } from '../anchors.js';
import {
  anchoredIds,
  effectsOf,
  model,
  pickOffer,
  refusingVerdicts,
  ROWS,
  situationRecords,
} from '../model.js';
import { PALETTE_ONLY } from '../paletteonly.js';
import { MENU_ROWS, menuRecords } from '../menus.js';
import { SHORTCUTS, comboOf, findShortcut, shortcutRecords } from '../shortcuts.js';
import { EFFECT_IDS, createDesktopEffects } from '../../../src/shared/effects.js';
import {
  actionProblems,
  actionsOf,
  paletteMatches,
  UX_MODEL,
  UX_PALETTE_ONLY,
  type UxRecord,
} from '../../../src/shared/uxmodel.js';

const file = model();

describe('model()', () => {
  it('parses under UX_MODEL', () => {
    expect(() => UX_MODEL.parse(file)).not.toThrow();
  });

  it('lists every module in both tables', () => {
    const modules = new Set(file.situations.map((s) => s.module));
    for (const row of ROWS) expect(modules.has(row.module)).toBe(true);
    for (const row of MENU_ROWS) expect(modules.has(row.module)).toBe(true);
    const count = (rows: readonly { situations: readonly unknown[] }[]) =>
      rows.reduce((n, row) => n + row.situations.length, 0);
    expect(file.situations.length).toBe(count(ROWS) + count(MENU_ROWS));
  });

  it('gives no two records in one situation the same key', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        expect(duplicateKeys(row.controls(situation.state))).toEqual([]);
      }
    }
  });

  /**
   * A repeat here can only be an FNV-1a collision: no two controls in one situation share a key,
   * and `VnToolMeta.identity()` reads a strict superset of what `keyOf` reads. Eight hex digits
   * over some three hundred segments per scope is close enough to the birthday bound to be worth
   * asserting, since a collision would silently merge two controls in `uxmodel.test.ts`.
   */
  it('gives no two records in one situation the same widgetPath', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        const paths = situationRecords(row, situation).map((record) => record.widgetPath);
        expect(paths.filter((path, at) => paths.indexOf(path) !== at)).toEqual([]);
      }
    }
  });

  // Two modules of one home (the asset editor's bar and its prompt) are re-resolved by key on the
  // same pane, so a key both produce would ring whichever was recorded last.
  it('gives no key to two modules of one home, over every situation', () => {
    const owners = new Map<string, Set<string>>();
    for (const row of ROWS) {
      for (const situation of row.situations) {
        for (const offer of row.controls(situation.state)) {
          const key = `${row.editor} ${keyOf(offer)}`;
          const modules = owners.get(key) ?? new Set<string>();
          modules.add(row.module);
          owners.set(key, modules);
        }
      }
    }
    const shared = [...owners].filter(([, modules]) => modules.size > 1).map(([key]) => key);
    expect(shared).toEqual([]);
  });

  it('surfaces every refusing verdict in a fixture verbatim', () => {
    const lost: string[] = [];
    for (const row of ROWS) {
      for (const situation of row.situations) {
        const surfaced = new Set(
          situationRecords(row, situation).map((r) =>
            r.offer.ok ? r.offer.tooltip : r.offer.refusal.reason,
          ),
        );
        for (const message of refusingVerdicts(situation.state)) {
          if (!surfaced.has(message)) lost.push(`${row.module}/${situation.name}: ${message}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it('stamps reasonFrom on exactly the refusals worded by the stack', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        const worded = new Set(refusingVerdicts(situation.state));
        for (const record of situationRecords(row, situation)) {
          const fromStack = !record.offer.ok && worded.has(record.offer.refusal.reason);
          expect(record.reasonFrom === 'stack').toBe(fromStack);
        }
      }
    }
  });

  it('lists the menu records the menu table yields, record for record', () => {
    expect(file.records.filter((r) => r.via === 'menu')).toEqual(menuRecords());
  });

  it('writes the shortcut table as its shortcuts section', () => {
    expect(file.shortcuts).toEqual(shortcutRecords());
    expect(file.shortcuts).toHaveLength(SHORTCUTS.length);
  });

  it('stamps shortcut on the controls a binding in their editor or the shell matches', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        for (const record of situationRecords(row, situation)) {
          const bound = findShortcut(record.effects[0]!, record.offer.on, row.editor);
          expect(record.shortcut).toEqual(bound === undefined ? undefined : comboOf(bound));
          if (bound !== undefined) expect(['global', row.editor]).toContain(bound.scope);
        }
      }
    }
    const grouped = file.records.find(
      (r) =>
        r.via === 'control' && r.editor === 'gengraph' && r.offer.id === 'gengraph.createGroup',
    );
    expect(grouped).toMatchObject({ shortcut: 'Ctrl+G' });
    const stamped = new Set(
      file.records.flatMap((r) =>
        r.via === 'control' && r.shortcut !== undefined
          ? [`${r.editor} ${r.key} ${r.shortcut}`]
          : [],
      ),
    );
    expect([...stamped].sort()).toEqual([
      'convo cmd:agent.setMode Shift+Tab',
      'gengraph cmd:gengraph.createGroup Ctrl+G',
      'gengraph cmd:gengraph.duplicateNode Shift+D',
      'gengraph cmd:gengraph.removeNode Delete',
      'gengraph cmd:gengraph.ungroup Ctrl+Alt+G',
      'header cmd:agent.setMode Shift+Tab',
      'header fx:history.move#redo Ctrl+Shift+Z',
      'header fx:history.move#undo Ctrl+Z',
      // The selected panel's four corners, each under the page's corner family
      'page cmd:story.setPanels#corner/2/1 Left',
      'page cmd:story.setPanels#corner/2/2 Left',
      'page cmd:story.setPanels#corner/2/3 Left',
      'page cmd:story.setPanels#corner/2/4 Left',
      'play fx:pane.view#back Left',
      'play fx:pane.view#forward Space',
    ]);
  });

  it('writes what a click does as its effects, in order', () => {
    const then = [{ id: 'view.open', props: { editor: 'script', where: 'here' } }];
    expect(
      effectsOf({
        id     : 'ui.publish',
        label  : 'greet',
        tooltip: 'Select it.',
        on     : 'scene/greet',
        ok     : true,
        props  : { sceneId: 'greet' },
        then,
      }),
    ).toEqual([{ id: 'ui.publish', props: { sceneId: 'greet' } }, ...then]);
    expect(
      effectsOf({
        id     : 'asset.accept',
        label  : 'Accept',
        tooltip: 'Accept it.',
        ok     : false,
        refusal: { reason: 'Nothing is selected.' },
      }),
    ).toEqual([{ id: 'asset.accept' }]);
  });

  /**
   * The command half of the same check is `uxmodel.test.ts`'s, in main, where the registry is.
   * Here the effect half: every effect a record names exists, with props its spec accepts.
   */
  it('names only effects the app declares, with props they accept', () => {
    const effects = createDesktopEffects();
    // A `then` step may name a command no control reaches, which the palette-only list vouches for
    const steps = file.records.flatMap((r) => actionsOf(r).map((step) => step.id));
    const vouched = steps.filter((id) => PALETTE_ONLY.some((p) => paletteMatches(p.match, id)));
    const commands = new Set([...anchoredIds(file), ...vouched]);
    expect(actionProblems(file, commands, effects)).toEqual([]);
    const record = file.records.find((r) => r.via === 'control');
    const made = {
      ...file,
      records: [
        { ...record, effects: [{ id: 'pane.vanish', props: {} }] },
        { ...record, effects: [{ id: 'pane.view', props: { what: 'sideways' } }] },
      ],
    } as typeof file;
    const problems = actionProblems(made, commands, effects);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/unknown id pane.vanish/);
    expect(problems[1]).toMatch(/must be one of/);
  });

  it('offers every effect the app declares, so the vocabulary carries no dead entry', () => {
    const offered = new Set(file.records.flatMap((r) => actionsOf(r).map((step) => step.id)));
    expect(EFFECT_IDS.filter((id) => !offered.has(id))).toEqual([]);
  });

  it('records no field an Offer does not declare', () => {
    const picked = pickOffer({
      id     : 'x.y',
      label  : 'X',
      tooltip: 'Does x.',
      ok     : true,
      props  : { a: 1 },
      note   : 'rider',
    } as never);
    expect(picked).toEqual({
      id     : 'x.y',
      label  : 'X',
      tooltip: 'Does x.',
      ok     : true,
      props  : { a: 1 },
    });
  });
});

describe('ux-model.json', () => {
  const committed = UX_MODEL.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../../../ux-model.json'), 'utf8')),
  );

  // Record by record rather than one deep equality, so a stale file names the first control that
  // moved instead of printing a diff the size of the file.
  it('equals a regeneration (run `pnpm gen:uxmodel` after touching rules/** or a situation)', () => {
    const name = (r: UxRecord | undefined) =>
      r === undefined
        ? '(none)'
        : `${r.module}/${r.situation} ${r.via === 'control' ? r.key : `${r.when} ${r.id}`}`;
    const first = file.records.findIndex(
      (record, i) => JSON.stringify(record) !== JSON.stringify(committed.records[i]),
    );
    const hint = 'differs from model(); run `pnpm gen:uxmodel`';
    if (first >= 0) {
      const fresh = file.records[first];
      const stale = committed.records[first];
      expect({ record: name(fresh), hint, committed: stale }).toEqual({
        record: name(fresh),
        hint,
        committed: fresh,
      });
    }
    expect(committed.records.length).toBe(file.records.length);
    expect(committed.situations).toEqual(file.situations);
    expect(committed.paletteOnly).toEqual(file.paletteOnly);
    expect(committed.shortcuts).toEqual(file.shortcuts);
    expect(committed.menuExempt).toEqual(file.menuExempt);
  });
});

describe('PALETTE_ONLY', () => {
  it('parses entry by entry', () => {
    for (const entry of PALETTE_ONLY) expect(() => UX_PALETTE_ONLY.parse(entry)).not.toThrow();
  });

  it('names no command a control already runs', () => {
    const anchored = anchoredIds(file);
    const overlaps = PALETTE_ONLY.flatMap((entry) =>
      anchored.filter((id) => paletteMatches(entry.match, id)).map((id) => `${entry.match} ${id}`),
    );
    expect(overlaps).toEqual([]);
  });

  it('lists each match once', () => {
    const matches = PALETTE_ONLY.map((entry) => entry.match);
    expect(new Set(matches).size).toBe(matches.length);
  });
});
