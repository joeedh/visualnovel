/**
 * The coverage rule over the derived model (`docs/reference/guided-tours.md`, Part III): every
 * command the registry lists is either the `id` of some record in `apps/desktop/ux-model.json` or
 * matches a `paletteOnly` entry, and every entry earns its place by matching a command no record
 * names. The file is read as JSON, never derived here, so this test needs nothing from the renderer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopEffects } from '../commands/catalog-entry.js';
import { createDesktopRegistry } from '../commands/index.js';
import { actionProblems, actionsOf, paletteMatches, UX_MODEL } from '../../shared/uxmodel.js';

const model = UX_MODEL.parse(
  JSON.parse(readFileSync(resolve(__dirname, '../../../ux-model.json'), 'utf8')),
);

const registry = createDesktopRegistry();
const live = registry
  .list()
  .map((command) => command.id)
  .sort();

// The command ids only: an effect is a control's own doing and is checked against its registry
const anchored = new Set(
  model.records
    .map((record) => (record.via === 'control' ? record.offer.id : record.id))
    .filter((id) => !desktopEffects.has(id)),
);

const listed = (id: string) => model.paletteOnly.some((entry) => paletteMatches(entry.match, id));

interface SweptRecord {
  id: string;
  editor: string;
  key?: string;
  when?: string;
  supplies?: string[];
  form?: boolean;
  refused?: string;
}

const sweep = JSON.parse(readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8')) as {
  records: SweptRecord[];
};

describe('ux-model.json against the registry', () => {
  it('names only commands that exist', () => {
    expect([...anchored].filter((id) => !live.includes(id)).sort()).toEqual([]);
  });

  it('names only commands or effects in every action, with props the effect accepts', () => {
    expect(actionProblems(model, new Set(live), desktopEffects)).toEqual([]);
  });

  it('binds a shortcut only to a command or an effect, apart from main’s own accelerators', () => {
    const unknown = model.shortcuts
      .filter(
        (s) => s.scope !== 'main' && !live.includes(s.runs.id) && !desktopEffects.has(s.runs.id),
      )
      .map((s) => `${s.scope} ${s.key} ${s.runs.id}`);
    expect(unknown).toEqual([]);
  });

  it('gives every command a control or a reason', () => {
    const uncovered = live.filter((id) => !anchored.has(id) && !listed(id));
    expect(uncovered).toEqual([]);
  });

  it('lists no command a control already runs', () => {
    const both = live.filter((id) => anchored.has(id) && listed(id));
    expect(both).toEqual([]);
  });

  it('keeps no palette-only entry that matches nothing', () => {
    const dead = model.paletteOnly
      .filter((entry) => !live.some((id) => !anchored.has(id) && paletteMatches(entry.match, id)))
      .map((entry) => entry.match);
    expect(dead).toEqual([]);
  });
});

/**
 * One direction only: what the sweep drew, the situations must list. The other direction is not
 * a rule, because a situation can describe a state the swept project never reached.
 */
describe('ux-model.json against anchors.json', () => {
  const controls = model.records.filter((r) => r.via === 'control');
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  it('lists every control the sweep drew, with the same form and supplies', () => {
    const unlisted = sweep.records
      .filter((swept) => swept.key !== undefined)
      .filter(
        (swept) =>
          !controls.some(
            (record) =>
              record.editor === swept.editor &&
              record.offer.id === swept.id &&
              (swept.form === undefined || record.offer.form === swept.form) &&
              (swept.supplies === undefined || same(record.offer.supplies, swept.supplies)),
          ),
      )
      .map((swept) => `${swept.editor} ${swept.key}`);
    expect(unlisted).toEqual([]);
  });

  it('lists the same menu entries as the sweep, entry for entry', () => {
    const pair = (r: { when?: string; id: string }) => `${r.when ?? ''} ${r.id}`;
    // One entry per (when, id): the model repeats a row per situation, the sweep records it once
    const derived = [...new Set(model.records.filter((r) => r.via === 'menu').map(pair))].sort();
    const swept = [...new Set(sweep.records.filter((r) => r.key === undefined).map(pair))].sort();
    expect(derived).toEqual(swept);
  });
});

/**
 * A mutating command reachable from a menu is undoable or confirms. A menu row runs on the click,
 * so a command that neither undoes nor asks first is one mistaken click from an irreversible
 * change; a row that opens the command's form is the form's to confirm. `menuExempt` lists the
 * allowed exceptions with reasons, and an entry there that no menu row runs on the click is dead.
 */
describe('a mutating command reachable from a menu', () => {
  const byId = new Map(registry.list().map((command) => [command.id, command]));
  const clicked = new Set(
    model.records
      .flatMap((record) => (record.via === 'menu' && !record.form ? [record.id] : []))
      .filter((id) => !desktopEffects.has(id)),
  );
  const exempt = new Set(model.menuExempt.map((entry) => entry.id));
  const safe = (id: string) => {
    const command = byId.get(id);
    return !command || !command.mutating || command.undoable === true || command.confirm === true;
  };

  it('is undoable, confirms, or is exempt with a reason', () => {
    const unguarded = [...clicked].filter((id) => !safe(id) && !exempt.has(id)).sort();
    expect(unguarded).toEqual([]);
  });

  it('keeps no exemption a menu row does not need', () => {
    const dead = [...exempt].filter((id) => !clicked.has(id) || safe(id)).sort();
    expect(dead).toEqual([]);
  });
});

/**
 * The sparing rule (`docs/reference/swappingPaneEditors.md`): an editor the app decides to show lands in a
 * pane the router picks, never one a surface chose for itself. In the model that reads as a
 * `view.open` naming no `where`, or `elsewhere`, with two exceptions: `here` from a routed row,
 * whose placement `routeFor` decided from what is visible, and `popup` for the one entry that
 * opens the agent report as a floating window. No control or menu row splits a pane.
 */
describe('every view.open in the model', () => {
  // The modules whose rows come from `openOf(routeFor(...))`, and so may say `here`
  const routed = new Set(['documents', 'diagnostics', 'script', 'wiki']);
  const opens = model.records.flatMap((record) =>
    actionsOf(record)
      .filter((action) => action.id === 'view.open')
      .map((action) => ({ record, where: action.props?.['where'] })),
  );

  it('exists', () => {
    expect(opens.length).toBeGreaterThan(0);
  });

  it('leaves the pane to the router, apart from a routed here and the report popup', () => {
    const chosen = opens
      .filter(({ record, where }) => {
        if (where === undefined || where === 'elsewhere') return false;
        if (where === 'here') return !routed.has(record.module);
        if (where === 'popup')
          return !(
            record.via === 'menu' &&
            record.module === 'headermenus' &&
            record.on === 'report'
          );
        return true;
      })
      .map(({ record, where }) => `${record.module}/${record.situation} ${String(where)}`);
    expect(chosen).toEqual([]);
  });
});
