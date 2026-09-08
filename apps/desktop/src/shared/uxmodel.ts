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
import { z } from 'zod';
import { ANCHOR_HOMES } from './editors.js';

/** `PropValue` as `@vn/commands` declares it: what the DSL can express. */
const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const props = z.record(z.string(), propValue);

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
  z.object({ ...control, ok: z.literal(true), props }).strict(),
  z.object({ ...control, ok: z.literal(false), refusal }).strict(),
]);

const editor = z.enum(ANCHOR_HOMES as [string, ...string[]]);

const situated = {
  editor,
  module   : z.string().min(1),
  situation: z.string().min(1),
};

/**
 * One control in one situation. `reasonFrom: 'stack'` marks a refused control whose reason is the
 * message of a `command:check` verdict in the situation's state, which is what the sweep's
 * wording comparison is scoped to.
 */
const controlRecord = z
  .object({
    ...situated,
    via       : z.literal('control'),
    key       : z.string().min(1),
    offer     : UX_OFFER,
    reasonFrom: z.literal('stack').optional(),
  })
  .strict();

/**
 * One entry of the document tree's right-click menu, under the node kind it is drawn for. A menu
 * entry carries no tooltip today, so none is invented here.
 */
const menuRecord = z
  .object({
    ...situated,
    via  : z.literal('menu'),
    when : z.string().min(1),
    id   : z.string().min(1),
    label: z.string(),
    props: props.optional(),
    form : z.boolean().optional(),
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

export const UX_MODEL = z
  .object({
    situations : z.array(UX_SITUATION),
    records    : z.array(UX_RECORD),
    paletteOnly: z.array(UX_PALETTE_ONLY),
  })
  .strict();

export type UxOffer = z.infer<typeof UX_OFFER>;
export type UxRecord = z.infer<typeof UX_RECORD>;
export type UxControlRecord = Extract<UxRecord, { via: 'control' }>;
export type UxMenuRecord = Extract<UxRecord, { via: 'menu' }>;
export type UxSituation = z.infer<typeof UX_SITUATION>;
export type UxPaletteOnly = z.infer<typeof UX_PALETTE_ONLY>;
export type UxModel = z.infer<typeof UX_MODEL>;

/** Whether a palette-only entry covers a command id, under the one-star grammar. */
export function paletteMatches(match: string, id: string): boolean {
  if (match.startsWith('*.')) return id.endsWith(match.slice(1));
  if (match.endsWith('.*')) return id.startsWith(match.slice(0, -1));
  return id === match;
}
