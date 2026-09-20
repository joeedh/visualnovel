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
import {
  actionProblems,
  actionsOf,
  paletteMatches,
  UX_MODEL,
  type UxAction,
} from '../../shared/uxmodel.js';

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
  /** The meta tag's own name for the control, on a control record. Menu records carry none. */
  widgetPath?: string;
  when?: string;
  supplies?: string[];
  form?: boolean;
  then?: UxAction[];
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
 * The derived model against the sweep, on the fields a fixture and a live screen can agree about.
 *
 * One direction only: what the sweep drew, the situations must list. The other is not a rule,
 * because a situation can describe a state the swept project never reached — 170 derived
 * `(editor, widgetPath)` pairs in homes the sweep visited were not drawn there.
 *
 * **`enabled`, the tooltip and the refusal sentence are deliberately not compared, and must not
 * be added.** The derived tier is situation-indexed and the measured tier is not: a rule module
 * answers `controls(state)` once per situation, so 981 derived control records collapse to 302
 * `(editor, widgetPath)` pairs, 46 of which carry records that disagree with each other on
 * `offer.ok`. A measured record observes one screen state and keys onto several derived records
 * holding contradictory values for exactly those fields, so the comparison would be a coin toss.
 * They have a better oracle in any case: the sweep asks `stack.check` per command anchor and
 * reports both a verdict and a wording disagreement, and the stack is what the rules echo.
 *
 * Prop values are out for a second reason. The derived tier's subjects are fixtures and the
 * sweep's are the swept project's, so a scene id, an asset hash and `view.open`'s `where` differ
 * by construction. `then` is compared by shape — each action's id and its prop names — which is
 * the part a fixture and a project do share.
 *
 * `header` needs no exclusion: it has no measured control records at all, because the sweep
 * iterates `view.open`'s editor list and the header is not an editor.
 */
describe('ux-model.json against anchors.json', () => {
  const controls = model.records.filter((r) => r.via === 'control');
  const drew = sweep.records.filter((record) => record.key !== undefined);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const shapeOf = (then: readonly UxAction[] | undefined) =>
    (then ?? []).map(
      (step) =>
        `${step.id}(${Object.keys(step.props ?? {})
          .sort()
          .join(',')})`,
    );

  it('lists every control the sweep drew, with the same form, supplies and tail', () => {
    const unlisted = drew
      .filter(
        (swept) =>
          !controls.some(
            (record) =>
              record.editor === swept.editor &&
              record.offer.id === swept.id &&
              same(record.offer.form, swept.form) &&
              same(record.offer.supplies, swept.supplies) &&
              same(shapeOf(record.offer.ok ? record.offer.then : undefined), shapeOf(swept.then)),
          ),
      )
      .map((swept) => `${swept.editor} ${swept.key}`);
    expect(unlisted).toEqual([]);
  });

  /**
   * The two tiers name a control the same way, wherever both can name it.
   *
   * Only some controls can be named on both sides. `widgetSegment` hashes each tool's
   * `identity()`, which carries the offer's `on`, and `on` is often a subject — a scene id, a
   * line id, an asset hash. The derived tier's subjects come from fixtures and the sweep's from
   * the swept project, so those two names differ by construction and there is nothing to compare.
   * What is left is every control whose `on` is fixed or absent, and there the path must be the
   * same string on both sides and must stand for the same offer.
   */
  it('gives one control one widgetPath in both tiers', () => {
    const derivedAt = new Map<string, typeof controls>();
    for (const record of controls) {
      const at = `${record.editor} ${record.widgetPath}`;
      derivedAt.set(at, [...(derivedAt.get(at) ?? []), record]);
    }
    const shared = drew.filter((swept) => derivedAt.has(`${swept.editor} ${swept.widgetPath}`));
    // Guards against the day a rename empties the population and leaves the rule passing vacuously
    expect(shared.length).toBeGreaterThan(100);
    const disagreeing = shared.flatMap((swept) =>
      (derivedAt.get(`${swept.editor} ${swept.widgetPath}`) ?? [])
        .filter(
          (record) =>
            record.key !== swept.key ||
            !same(record.offer.form, swept.form) ||
            !same(record.offer.supplies, swept.supplies) ||
            !same(shapeOf(record.offer.ok ? record.offer.then : undefined), shapeOf(swept.then)),
        )
        .map((record) => `${swept.editor} ${swept.key} vs ${record.module}/${record.situation}`),
    );
    expect(disagreeing).toEqual([]);
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
  const routed = new Set(['documents', 'diagnostics', 'script', 'wiki', 'sheetform']);
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
