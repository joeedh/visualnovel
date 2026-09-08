/**
 * The shape of `apps/desktop/ux-model.json`, the derived UX model
 * (`docs/reference/guided-tours.md`, Part III).
 *
 * The file is written by `scripts/gen-ux-model.mjs` from the rule modules' `controls()` over the
 * situation list, and read back by tests in main and in the renderer, so the schema sits where
 * both can reach it. Every object is strict: a field the schema does not name fails to parse
 * rather than travelling as cargo nothing checks.
 *
 * The `offer` half restates `Offer` from `renderer/rules/anchors.ts` in zod. The two are tied by
 * the driver, whose return value is typed as {@link UxModel} and built from real offers, so a
 * field added to one and not the other fails to compile there.
 */
import { coerceProps, type EffectRegistry } from '@vn/commands';
import { z } from 'zod';
import { ANCHOR_HOMES } from './editors.js';

/** `PropValue` as `@vn/commands` declares it: what the DSL can express. */
const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const props = z.record(z.string(), propValue);

/** `Action` in `renderer/rules/anchors.ts`: a command or an effect, with the props it is given. */
const action = z.object({ id: z.string().min(1), props: props.optional() }).strict();

/** What every control carries on either branch: `Control` in `renderer/rules/anchors.ts`. */
const control = {
  id      : z.string().min(1),
  label   : z.string(),
  tooltip : z.string(),
  on      : z.string().optional(),
  supplies: z.array(z.string()).optional(),
  form    : z.boolean().optional(),
};

/** path.ux's `Refusal`: the short sentence, and a longer one behind the tooltip's expander. */
const refusal = z
  .object({ reason: z.string().min(1), description: z.string().optional() })
  .strict();

export const UX_OFFER = z.discriminatedUnion('ok', [
  z.object({ ...control, ok: z.literal(true), props, then: z.array(action).optional() }).strict(),
  z.object({ ...control, ok: z.literal(false), refusal }).strict(),
]);

const editor = z.enum(ANCHOR_HOMES as [string, ...string[]]);

const situated = {
  editor,
  module   : z.string().min(1),
  situation: z.string().min(1),
};

/**
 * One control in one situation. `effects` is what the click does, in order: the offer's own
 * action and then its `then` list, or the bare id of a refused offer. `reasonFrom: 'stack'` marks
 * a refused control whose reason is the message of a `command:check` verdict in the situation's
 * state, which is what the sweep's wording comparison is scoped to. `shortcut` is the key
 * combination bound to the first effect, from the shortcut table.
 */
const controlRecord = z
  .object({
    ...situated,
    via       : z.literal('control'),
    key       : z.string().min(1),
    offer     : UX_OFFER,
    effects   : z.array(action).min(1),
    reasonFrom: z.literal('stack').optional(),
    shortcut  : z.string().min(1).optional(),
  })
  .strict();

/**
 * One entry of a menu, under `when`: the node kind a tree menu is drawn for, or
 * `header/<menu>[/<submenu>]` for the header's. `refused` is the entry's own sentence where it is
 * drawn greyed, and `then` is what follows the entry's command or effect.
 */
const menuRecord = z
  .object({
    ...situated,
    via     : z.literal('menu'),
    when    : z.string().min(1),
    id      : z.string().min(1),
    label   : z.string(),
    tooltip : z.string().optional(),
    props   : props.optional(),
    form    : z.boolean().optional(),
    then    : z.array(action).optional(),
    refused : z.string().min(1).optional(),
    shortcut: z.string().min(1).optional(),
  })
  .strict();

export const UX_RECORD = z.discriminatedUnion('via', [controlRecord, menuRecord]);

/** A named fixture the driver ran a module over, and one sentence on what it gates. */
export const UX_SITUATION = z
  .object({ module: z.string().min(1), editor, name: z.string().min(1), why: z.string().min(1) })
  .strict();

/** A command with no control, and why. `match` is an id or a glob with one `*` at either end. */
export const UX_PALETTE_ONLY = z
  .object({
    match: z.string().regex(/^(\*\.[\w.]+|[\w.]+\.\*|[\w.]+)$/, 'an id, `ns.*` or `*.name`'),
    why  : z.string().min(1),
  })
  .strict();

/**
 * One key binding, from `renderer/rules/shortcuts.ts`. `scope` is `global`, an editor id or
 * `main`; `runs` is the action the key performs; `shadows` marks an editor binding that takes a
 * combination the shell also binds; `from` marks a binding copied from path.ux's own table.
 */
export const UX_SHORTCUT = z
  .object({
    scope  : z.string().min(1),
    key    : z.string().min(1),
    mods   : z.array(z.string().min(1)),
    runs   : action,
    shadows: z.literal(true).optional(),
    from   : z.literal('pathux').optional(),
  })
  .strict();

/** A mutating menu entry that neither undoes nor confirms, and why it is allowed to. */
export const UX_MENU_EXEMPT = z.object({ id: z.string().min(1), why: z.string().min(1) }).strict();

export const UX_MODEL = z
  .object({
    situations : z.array(UX_SITUATION),
    records    : z.array(UX_RECORD),
    paletteOnly: z.array(UX_PALETTE_ONLY),
    shortcuts  : z.array(UX_SHORTCUT),
    menuExempt : z.array(UX_MENU_EXEMPT),
  })
  .strict();

export type UxOffer = z.infer<typeof UX_OFFER>;
export type UxRecord = z.infer<typeof UX_RECORD>;
export type UxControlRecord = Extract<UxRecord, { via: 'control' }>;
export type UxMenuRecord = Extract<UxRecord, { via: 'menu' }>;
export type UxAction = z.infer<typeof action>;
export type UxSituation = z.infer<typeof UX_SITUATION>;
export type UxPaletteOnly = z.infer<typeof UX_PALETTE_ONLY>;
export type UxShortcut = z.infer<typeof UX_SHORTCUT>;
export type UxMenuExempt = z.infer<typeof UX_MENU_EXEMPT>;
export type UxModel = z.infer<typeof UX_MODEL>;

/** Every action a record carries, in the order the click performs them. */
export function actionsOf(record: UxRecord): UxAction[] {
  if (record.via === 'control') return record.effects;
  return [
    { id: record.id, ...(record.props === undefined ? {} : { props: record.props }) },
    ...(record.then ?? []),
  ];
}

/**
 * Every action in the model that names neither a command nor an effect, or names an effect with
 * props its spec refuses. Empty is the healthy answer; the tests in main and in the renderer both
 * ask, so an id nothing registers cannot enter the file from either side.
 */
export function actionProblems(
  model: UxModel,
  commands: ReadonlySet<string>,
  effects: EffectRegistry,
): string[] {
  const problems: string[] = [];
  const where = (record: UxRecord) =>
    `${record.module}/${record.situation} ${record.via === 'control' ? record.key : record.id}`;
  for (const record of model.records) {
    for (const step of actionsOf(record)) {
      const effect = effects.get(step.id);
      if (effect === undefined) {
        if (!commands.has(step.id)) problems.push(`${where(record)}: unknown id ${step.id}`);
        continue;
      }
      // A refused offer carries no props, so only an accepted action is coerced.
      if (step.props === undefined) continue;
      const coerced = coerceProps(effect.props, step.props);
      if (!coerced.ok) problems.push(`${where(record)}: ${step.id} ${coerced.errors.join('; ')}`);
    }
  }
  return problems;
}

/** Whether a palette-only entry covers a command id, under the one-star grammar. */
export function paletteMatches(match: string, id: string): boolean {
  if (match.startsWith('*.')) return id.endsWith(match.slice(1));
  if (match.endsWith('.*')) return id.startsWith(match.slice(0, -1));
  return id === match;
}
