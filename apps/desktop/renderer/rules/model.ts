/**
 * The derived UX model: every rule module's `controls` run over its situations, plus every menu
 * over its own (`rules/menus.ts`), as one file (`docs/reference/guided-tours.md`, Part III). No
 * DOM, no main process: `scripts/gen-ux-model.mjs` bundles this for node and writes
 * `apps/desktop/ux-model.json`, and `tests/model.test.ts` compares that file against a fresh call.
 *
 * The output is a pure function of the table below. It carries no timestamp, sha or path, so the
 * committed file either equals a regeneration or is stale, with nothing in between.
 */
import { keyOf, type Offer } from './anchors.js';
import { PALETTE_ONLY } from './paletteonly.js';
import { MENU_EXEMPT } from './menuexempt.js';
import { MENU_ROWS, menuRecords } from './menus.js';
import { isEffectId } from '../../src/shared/effects.js';
import type { Situation } from './situations/situation.js';
import type { AnchorHome } from '../../src/shared/editors.js';
import type { CommandCheck } from '../../src/shared/ipc.js';
import type { UxAction, UxControlRecord, UxModel, UxOffer } from '../../src/shared/uxmodel.js';
import * as headerbar from './headerbar.js';
import * as notifications from './notifications.js';
import * as approvals from './approvals.js';
import * as diagnostics from './diagnostics.js';
import * as convobar from './convobar.js';
import * as assetview from './assetview.js';
import * as promptview from './promptview.js';
import * as branch from './branch/controls.js';
import * as documents from './documents.js';
import * as gengraph from './gengraph.js';
import * as onboarding from './onboarding.js';
import * as projectbar from './projectbar.js';
import * as reportconvo from './reportconvo.js';
import * as script from './script.js';
import * as skills from './skills.js';
import * as taskGraph from './taskGraph.js';
import * as tasklist from './tasklist.js';
import * as timeline from './timeline/controls.js';
import * as wiki from './wiki.js';
import { SITUATIONS as HEADERBAR } from './situations/headerbar.js';
import { SITUATIONS as NOTIFICATIONS } from './situations/notifications.js';
import { SITUATIONS as APPROVALS } from './situations/approvals.js';
import { SITUATIONS as DIAGNOSTICS } from './situations/diagnostics.js';
import { SITUATIONS as CONVOBAR } from './situations/convobar.js';
import { SITUATIONS as ASSETVIEW } from './situations/assetview.js';
import { SITUATIONS as PROMPTVIEW } from './situations/promptview.js';
import { SITUATIONS as BRANCH } from './situations/branch.js';
import { SITUATIONS as DOCUMENTS } from './situations/documents.js';
import { SITUATIONS as GENGRAPH } from './situations/gengraph.js';
import { SITUATIONS as ONBOARDING } from './situations/onboarding.js';
import { SITUATIONS as PROJECTBAR } from './situations/projectbar.js';
import { SITUATIONS as REPORTCONVO } from './situations/reportconvo.js';
import { SITUATIONS as SCRIPT } from './situations/script.js';
import { SITUATIONS as SKILLS } from './situations/skills.js';
import { SITUATIONS as TASKGRAPH } from './situations/taskGraph.js';
import { SITUATIONS as TASKLIST } from './situations/tasklist.js';
import { SITUATIONS as TIMELINE } from './situations/timeline.js';
import { SITUATIONS as WIKI } from './situations/wiki.js';

/**
 * One rule module: where it draws, what it answers, and the states to ask it about. `controls` is
 * a method rather than a function-typed field so a row over one state type is a `Row<unknown>`.
 */
export interface Row<S> {
  module: string;
  editor: AnchorHome;
  /** The module's source, repo-relative, so a record says where its rule lives. */
  file: string;
  situations: readonly Situation<S>[];
  controls(state: S): readonly Offer[];
}

const row = <S>(
  module: string,
  editor: AnchorHome,
  situations: readonly Situation<S>[],
  controls: (state: S) => readonly Offer[],
  file = `apps/desktop/renderer/rules/${module}.ts`,
): Row<S> => ({ module, editor, file, situations, controls });

/** Every module that answers `controls`, in the order the file lists them. */
export const ROWS: readonly Row<unknown>[] = [
  row('headerbar', 'header', HEADERBAR, headerbar.controls),
  row('notifications', 'notifications', NOTIFICATIONS, notifications.controls),
  row('approvals', 'approvals', APPROVALS, approvals.controls),
  row('diagnostics', 'diagnostics', DIAGNOSTICS, diagnostics.controls),
  row('assetview', 'asset', ASSETVIEW, assetview.controls),
  row('promptview', 'asset', PROMPTVIEW, ({ view, editing }) => promptview.controls(view, editing)),
  row(
    'branch',
    'branches',
    BRANCH,
    branch.controls,
    'apps/desktop/renderer/rules/branch/controls.ts',
  ),
  row('convobar', 'convo', CONVOBAR, convobar.controls),
  row('documents', 'documents', DOCUMENTS, documents.controls),
  row('gengraph', 'gengraph', GENGRAPH, gengraph.controls),
  row('onboarding', 'onboarding', ONBOARDING, onboarding.controls),
  row('projectbar', 'project', PROJECTBAR, projectbar.controls),
  row('reportconvo', 'report', REPORTCONVO, reportconvo.controls),
  row('script', 'script', SCRIPT, script.controls),
  row('skills', 'skills', SKILLS, skills.controls),
  row('taskGraph', 'taskgraph', TASKGRAPH, taskGraph.controls),
  row('tasklist', 'tasklist', TASKLIST, tasklist.controls),
  row(
    'timeline',
    'timeline',
    TIMELINE,
    timeline.controls,
    'apps/desktop/renderer/rules/timeline/controls.ts',
  ),
  row('wiki', 'wiki', WIKI, wiki.controls),
];

/**
 * The offer's declared fields and nothing else. A module may hand back a wider object, as the asset
 * editor's do with what the editor reads back (`act`, `note`, `variants`), and those riders are
 * neither what the control does nor stable across fixtures. Typed over `Offer`'s own keys, so a
 * field added to `Control` is either picked here or fails to compile.
 */
export function pickOffer(offer: Offer): UxOffer {
  const control = {
    id     : offer.id,
    label  : offer.label,
    tooltip: offer.tooltip,
    ...(offer.on === undefined ? {} : { on: offer.on }),
    ...(offer.supplies === undefined ? {} : { supplies: [...offer.supplies] }),
    ...(offer.form === undefined ? {} : { form: offer.form }),
  };
  if (offer.ok) {
    return {
      ...control,
      ok   : true,
      props: { ...offer.props },
      ...(offer.then === undefined ? {} : { then: offer.then.map((a) => ({ ...a })) }),
    };
  }
  const { reason, description } = offer.refusal;
  return {
    ...control,
    ok     : false,
    refusal: { reason, ...(description === undefined ? {} : { description }) },
  };
}

/**
 * Every refusing `command:check` verdict inside a fixture, found by shape, because a verdict names
 * no command and each module keys its own. A `Refusal` (`{ reason }`) is not a verdict.
 */
export function refusingVerdicts(state: unknown, found: string[] = []): string[] {
  if (state === null || typeof state !== 'object') return found;
  const value = state as Record<string, unknown>;
  if (value.state === 'refuse' && typeof value.message === 'string') {
    found.push((value as unknown as CommandCheck).message);
    return found;
  }
  for (const child of Object.values(value)) refusingVerdicts(child, found);
  return found;
}

/** What a click does, in order: the offer's own action and its `then` list, or a refusal's bare id. */
export function effectsOf(offer: UxOffer): UxAction[] {
  if (!offer.ok) return [{ id: offer.id }];
  return [{ id: offer.id, props: offer.props }, ...(offer.then ?? [])];
}

/** The records one situation yields: each offer picked, and stamped where its reason is the stack's. */
export function situationRecords<S>(row: Row<S>, situation: Situation<S>): UxControlRecord[] {
  const stackWorded = new Set(refusingVerdicts(situation.state));
  return row.controls(situation.state).map((offer) => {
    const picked = pickOffer(offer);
    const fromStack = !picked.ok && stackWorded.has(picked.refusal.reason);
    return {
      via      : 'control',
      editor   : row.editor,
      module   : row.module,
      situation: situation.name,
      key      : keyOf(offer),
      offer    : picked,
      effects  : effectsOf(picked),
      ...(fromStack ? { reasonFrom: 'stack' } : {}),
    };
  });
}

/**
 * The whole file: the control situations in table order, then the menu situations, then every
 * record in the same order, then the palette-only and exemption lists.
 */
export function model(): UxModel {
  const situations: UxModel['situations'] = [];
  const records: UxModel['records'] = [];
  for (const row of ROWS) {
    for (const situation of row.situations) {
      situations.push({
        module: row.module,
        editor: row.editor,
        name  : situation.name,
        why   : situation.why,
      });
      records.push(...situationRecords(row, situation));
    }
  }
  for (const row of MENU_ROWS) {
    for (const situation of row.situations) {
      situations.push({
        module: row.module,
        editor: row.editor,
        name  : situation.name,
        why   : situation.why,
      });
    }
  }
  records.push(...menuRecords());
  return {
    situations,
    records,
    paletteOnly: PALETTE_ONLY.map((entry) => ({ ...entry })),
    shortcuts  : [],
    menuExempt : MENU_EXEMPT.map((entry) => ({ ...entry })),
  };
}

/** Every command id some record names, sorted, which is what the coverage rule reads. */
export function anchoredIds(file: UxModel): string[] {
  return [
    ...new Set(
      file.records
        .map((record) => (record.via === 'control' ? record.offer.id : record.id))
        .filter((id) => !isEffectId(id)),
    ),
  ].sort();
}
