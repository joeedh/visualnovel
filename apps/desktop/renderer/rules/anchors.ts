/**
 * The anchor layer's rules: what a surface can be asked to do as data, what an anchor records,
 * and how a wanted invocation resolves against the anchors currently drawn.
 *
 * The load-bearing rule is that an anchor runs the same invocation it points at — it is never
 * built from a description of one. `act()` in `pathux/anchors.ts` is what enforces that; this
 * module is the shapes it records and the pure resolution over them, kept here because the
 * desktop jest project is node-only and a pane can only be checked live over CDP.
 */
import type { EditorId } from '../../src/shared/editors.js';
import type { PropValue } from '../../src/shared/ipc.js';

/** What a surface can be asked to do, as data, before it is a click. */
export interface Action {
  id: string;
  props: Record<string, PropValue>;
}

/**
 * An invocation a surface is offering, or the surface's own sentence for why it is not.
 *
 * A refusal may still name the command it is about. A greyed control is recorded as an anchor
 * rather than as an absence, so a tour asked for that command can ring the control and say the
 * app's own refusal instead of inventing one — which it can only do if the refusal is findable
 * by the id the step names.
 */
export type Offer =
  | (Action & { ok: true; label?: string })
  | { ok: false; reason: string; id?: string };

/** The part of a `DOMRect` the overlay reads. Typed structurally so a test needs no DOM. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * What the overlay needs of an anchored node. `UIBase extends HTMLElement`, so a path.ux widget
 * and a raw `<button>` both satisfy this with no adapter.
 */
export interface AnchorNode {
  getBoundingClientRect(): AnchorRect;
}

/**
 * How the ring is placed and checked. `dom` is wired by `act()` — one listener and one record
 * from one object. `pick` is wired by a canvas's existing `pick()` dispatch, and carries its own
 * rect because the graph editors' geometry comes from the layout rather than from the DOM.
 */
export type AnchorVia =
  | { kind: 'dom'; node: AnchorNode }
  | { kind: 'pick'; nodeId: string; rect?: AnchorRect };

/** One thing on screen that can be pointed at, and what pointing at it would do. */
export interface Anchor {
  /** `cmd:asset.regenerate` or `item:asset/<hash>` — see {@link commandKey}, {@link itemKey}. */
  key: string;
  /** The command a click runs. Absent on an `item:` anchor, whose click publishes a selection. */
  id?: string;
  /** The props known when the anchor was recorded. Partial wherever the widget supplies one. */
  props: Record<string, PropValue>;
  /** Prop names the click reads from the widget at commit time, so a step naming one is an input. */
  supplies?: string[];
  enabled: boolean;
  /** Why it is greyed. The sentence the rule already wrote, never invented here. */
  reason?: string;
  /** The `ui.*` fields an `item:` anchor's click publishes. */
  publishes?: Record<string, string>;
  editor: EditorId;
  via: AnchorVia;
}

/** How a step resolves against the screen: where to ring, what to say, or why there is nothing. */
export type Resolution =
  | { state: 'ready'; anchor: Anchor }
  | { state: 'input'; anchor: Anchor; supplies: string[] }
  | { state: 'disabled'; anchor: Anchor; reason: string }
  | { state: 'offscreen'; anchor: Anchor }
  | { state: 'wrong-subject'; anchor: Anchor; needs: Action }
  | { state: 'pane-closed'; editor: EditorId }
  | { state: 'absent' }
  | { state: 'unanchored' };

/** The screen as the resolver reads it: what is drawn, what is open, and what has scrolled away. */
export interface LiveAnchors {
  anchors: readonly Anchor[];
  open: readonly EditorId[];
  /** Keys whose rect lies outside the pane that drew them. */
  offscreen?: readonly string[];
}

/**
 * Which editors are known to anchor a command, swept once and read at planning time. Planning
 * happens before any pane is open, so this is what answers "where does `prompt.condense` live".
 */
export interface AnchorMap {
  editorsFor: Readonly<Record<string, readonly EditorId[]>>;
}

export const commandKey = (id: string): string => `cmd:${id}`;

/**
 * The key of a thing rather than an act — an asset, a scene, a line. The key must be domain
 * identity, never an index, a position or a label: indices break on any re-sort, and a tree's
 * labels carry a disambiguating suffix only on collision.
 */
export const itemKey = (kind: string, key: string): string => `item:${kind}/${key}`;

/** How an anchor's partial props stand against the ones a step names. */
export type Subsumption =
  | { state: 'ready' }
  | { state: 'input'; supplies: string[] }
  | { state: 'wrong-subject'; needs: Action };

/**
 * Whether this anchor would run the step, given that an anchor's props are partial by design.
 * Equality is the wrong test — against any input surface it would answer `wrong-subject` every
 * time, because the props the human is about to type are exactly the ones no anchor can record.
 *
 * A key the anchor records must equal the step's. A key only the step names must be one the
 * widget supplies, and then the step is an input rather than a click; an anchor that supplies
 * neither is incomplete, which is a bug worth reporting rather than hiding. An anchor with
 * `supplies` that the step names none of is still ready — the human is being shown where to
 * start.
 */
export function subsumes(anchor: Anchor, step: Action): Subsumption {
  const supplies = anchor.supplies ?? [];
  const needs: Record<string, PropValue> = {};
  const asked: string[] = [];

  for (const [name, value] of Object.entries(step.props)) {
    if (name in anchor.props) {
      if (!sameValue(anchor.props[name], value)) needs[name] = value;
    } else if (supplies.includes(name)) {
      asked.push(name);
    } else {
      needs[name] = value;
    }
  }

  if (Object.keys(needs).length > 0)
    return { state: 'wrong-subject', needs: { id: step.id, props: needs } };
  if (asked.length > 0) return { state: 'input', supplies: asked };
  return { state: 'ready' };
}

function sameValue(a: PropValue | undefined, b: PropValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/**
 * Where a step goes on screen, over a snapshot of what is drawn.
 *
 * `absent` and `unanchored` are different answers for the reason `Interaction.targets`
 * distinguishes an empty target list from `UNRESOLVED`: one is a statement about the screen, the
 * other about the map, and the caller needs to know which.
 */
export function resolveAnchor(map: AnchorMap, live: LiveAnchors, step: Action): Resolution {
  const offscreen = new Set(live.offscreen ?? []);
  const candidates = live.anchors.filter((anchor) => anchor.id === step.id);

  let mismatch: { anchor: Anchor; needs: Action } | undefined;
  for (const anchor of candidates) {
    const fit = subsumes(anchor, step);
    if (fit.state === 'wrong-subject') {
      mismatch ??= { anchor, needs: fit.needs };
      continue;
    }
    // Scrolling comes before every other answer an on-screen anchor would give: the overlay
    // brings it into view and asks again, and only then is there something to ring or grey.
    if (offscreen.has(anchor.key)) return { state: 'offscreen', anchor };
    if (!anchor.enabled) {
      return { state: 'disabled', anchor, reason: anchor.reason ?? 'This is not available here.' };
    }
    return fit.state === 'input'
      ? { state: 'input', anchor, supplies: fit.supplies }
      : { state: 'ready', anchor };
  }

  if (mismatch) return { state: 'wrong-subject', anchor: mismatch.anchor, needs: mismatch.needs };

  const editors = map.editorsFor[step.id] ?? [];
  if (editors.length === 0) return { state: 'unanchored' };
  if (editors.some((editor) => live.open.includes(editor))) return { state: 'absent' };
  return { state: 'pane-closed', editor: editors[0] as EditorId };
}

/**
 * Where a subject is chosen. This is what a `wrong-subject` resolution turns into: the tour rings
 * the row that publishes the selection, rather than the button that would act on the wrong one.
 */
export function resolveItem(live: LiveAnchors, kind: string, key: string): Resolution {
  const wanted = itemKey(kind, key);
  const anchor = live.anchors.find((entry) => entry.key === wanted);
  if (!anchor) return { state: 'absent' };
  if ((live.offscreen ?? []).includes(anchor.key)) return { state: 'offscreen', anchor };
  if (!anchor.enabled) {
    return { state: 'disabled', anchor, reason: anchor.reason ?? 'This cannot be selected.' };
  }
  return { state: 'ready', anchor };
}

/** One command's coverage, as the sweep and the doctree enumeration both write it. */
export interface AnchorRecord {
  id: string;
  editor: EditorId;
  /** The condition the record appeared under, so the map states its own coverage. */
  when?: string;
  supplies?: string[];
}

/** The map a tour plans against, folded from however many records name the same command. */
export function mapOf(records: readonly AnchorRecord[]): AnchorMap {
  const editorsFor: Record<string, EditorId[]> = {};
  for (const record of records) {
    const seen = (editorsFor[record.id] ??= []);
    if (!seen.includes(record.editor)) seen.push(record.editor);
  }
  return { editorsFor };
}
