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

/**
 * The app's toolbar, which is not a pane. It is drawn once at startup and cannot be closed, so it
 * never resolves to `pane-closed` and never leaves the open set.
 */
export const HEADER = 'header';

/** Where an anchor was drawn: a pane the author can close, or the toolbar that is always there. */
export type AnchorHome = EditorId | typeof HEADER;

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
 * How the ring is placed and checked. `dom` is wired by `act()` — one listener and one record from
 * one object. `pick` marks a target whose click the canvas resolves rather than the node: a graph's
 * node layer takes no pointer events, so a click on the box would land on the canvas underneath and
 * be answered by its `pick()`. The box is still where the ring goes, and it is still in the
 * document, so it is kept for its rect; `rect` stands in where there is no box to read.
 */
export type AnchorVia =
  | { kind: 'dom'; node: AnchorNode }
  | { kind: 'pick'; nodeId: string; node?: AnchorNode; rect?: AnchorRect };

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
  /**
   * The click opens the command's own form rather than running it, so every prop is typed there.
   * Reads as `supplies` over whatever the step names, which is what makes the palette a floor.
   */
  form?: boolean;
  enabled: boolean;
  /** Why it is greyed. The sentence the rule already wrote, never invented here. */
  reason?: string;
  /** The `ui.*` fields an `item:` anchor's click publishes. */
  publishes?: Record<string, string>;
  editor: AnchorHome;
  via: AnchorVia;
}

/** How a step resolves against the screen: where to ring, what to say, or why there is nothing. */
export type Resolution =
  | { state: 'ready'; anchor: Anchor }
  | { state: 'input'; anchor: Anchor; supplies: string[] }
  | { state: 'disabled'; anchor: Anchor; reason: string }
  | { state: 'offscreen'; anchor: Anchor }
  | { state: 'wrong-subject'; anchor: Anchor; needs: Action; holds: string[] }
  | { state: 'pane-closed'; editor: EditorId }
  | { state: 'absent' }
  | { state: 'unanchored' };

/** The screen as the resolver reads it: what is drawn, what is open, and what has scrolled away. */
export interface LiveAnchors {
  anchors: readonly Anchor[];
  open: readonly AnchorHome[];
  /** Keys whose rect lies outside the pane that drew them. */
  offscreen?: readonly string[];
}

/**
 * Which editors are known to anchor a command, swept once and read at planning time. Planning
 * happens before any pane is open, so this is what answers "where does `prompt.condense` live".
 */
export interface AnchorMap {
  editorsFor: Readonly<Record<string, readonly AnchorHome[]>>;
}

/** What a greyed control is reported as when its own rule left no sentence behind. */
export const UNAVAILABLE = 'This is not available here.';

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
  | {
      state: 'wrong-subject';
      needs: Action;
      /**
       * Which of `needs` the anchor records a different value for. The rest are props this
       * control does not take at all, which is an incomplete anchor rather than a subject the
       * author could select.
       */
      holds: string[];
    };

/**
 * Whether this anchor would run the step, given that an anchor's props are partial by design.
 * Equality is the wrong test — against any input surface it would answer `wrong-subject` every
 * time, because the props the human is about to type are exactly the ones no anchor can record.
 *
 * A key the anchor records must equal the step's. A key only the step names must be one the
 * widget supplies, and then the step is an input rather than a click; an anchor that supplies
 * neither is incomplete, which is a bug worth reporting rather than hiding. An anchor with
 * `supplies` that the step names none of is still ready — the human is being shown where to
 * start. A `form` anchor supplies whatever is asked of it, because its form holds every prop.
 *
 * The two ways a prop reaches `needs` are kept apart in `holds`, because only a prop the anchor
 * records a value for names a subject that is on screen somewhere else.
 */
export function subsumes(anchor: Anchor, step: Action): Subsumption {
  const supplies = anchor.supplies ?? [];
  const needs: Record<string, PropValue> = {};
  const holds: string[] = [];
  const asked: string[] = [];

  for (const [name, value] of Object.entries(step.props)) {
    if (name in anchor.props) {
      if (!sameValue(anchor.props[name], value)) {
        needs[name] = value;
        holds.push(name);
      }
    } else if (supplies.includes(name) || anchor.form) {
      asked.push(name);
    } else {
      needs[name] = value;
    }
  }

  if (Object.keys(needs).length > 0)
    return { state: 'wrong-subject', needs: { id: step.id, props: needs }, holds };
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
  // An item anchor has no `id`, so a step with none of its own would otherwise match every one of
  // them, subsume over no props, and ring an arbitrary tree row.
  const candidates = live.anchors.filter(
    (anchor) => anchor.id !== undefined && anchor.id === step.id,
  );

  let mismatch: { anchor: Anchor; needs: Action; holds: string[] } | undefined;
  for (const anchor of candidates) {
    const fit = subsumes(anchor, step);
    if (fit.state === 'wrong-subject') {
      mismatch ??= { anchor, needs: fit.needs, holds: fit.holds };
      continue;
    }
    // Scrolling comes before every other answer an on-screen anchor would give: the overlay
    // brings it into view and asks again, and only then is there something to ring or grey.
    if (offscreen.has(anchor.key)) return { state: 'offscreen', anchor };
    if (!anchor.enabled) {
      return { state: 'disabled', anchor, reason: anchor.reason ?? UNAVAILABLE };
    }
    return fit.state === 'input'
      ? { state: 'input', anchor, supplies: fit.supplies }
      : { state: 'ready', anchor };
  }

  if (mismatch) return { state: 'wrong-subject', ...mismatch };

  const editors = map.editorsFor[step.id] ?? [];
  if (editors.length === 0) return { state: 'unanchored' };
  if (editors.some((editor) => live.open.includes(editor))) return { state: 'absent' };
  // The toolbar cannot be closed, so a command the map places only there and that is nonetheless
  // not drawn is a statement about the screen rather than about a missing pane.
  const pane = editors.find((editor) => editor !== HEADER);
  return pane === undefined ? { state: 'absent' } : { state: 'pane-closed', editor: pane };
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

/**
 * Where the subject a step names is selected, for a step whose control acts on something else.
 *
 * Only the held props are searched, and only their string values: a prop the anchor does not
 * record is free text or a flag rather than a subject, and a conflict on a number or a boolean
 * names nothing on screen.
 *
 * A subject is written two ways, so both are looked for. A bare id — an asset hash, a `sceneId` —
 * is what an item anchor's click publishes. A composite rung id such as `character:aiko` is a kind
 * and a key, which is the shape of an item key. Empty values are skipped, since a click that
 * clears a field publishes `''` and every such anchor would otherwise match every other.
 *
 * `from` is the editor that gave the mismatch, preferred so the pane the author is already looking
 * at is the one that retargets. The selection is shared, so any pane's row would do.
 */
export function resolveSubject(
  live: LiveAnchors,
  needs: Action,
  holds: readonly string[],
  from?: AnchorHome,
): Resolution {
  const values = new Set<string>();
  const keys = new Set<string>();
  for (const name of holds) {
    const value = needs.props[name];
    if (typeof value !== 'string' || value === '') continue;
    values.add(value);
    const cut = value.indexOf(':');
    if (cut > 0) keys.add(itemKey(value.slice(0, cut), value.slice(cut + 1)));
  }
  if (values.size === 0) return { state: 'absent' };
  const selects = (anchor: Anchor): boolean =>
    keys.has(anchor.key) || Object.values(anchor.publishes ?? {}).some((id) => values.has(id));
  const found =
    live.anchors.find((anchor) => anchor.editor === from && selects(anchor)) ??
    live.anchors.find(selects);
  if (!found) return { state: 'absent' };
  if ((live.offscreen ?? []).includes(found.key)) return { state: 'offscreen', anchor: found };
  return { state: 'ready', anchor: found };
}

/**
 * Where a thing is drawn, found by its id alone rather than by kind as well.
 *
 * A gesture carries the id of a scene, a shot or a line and never says which of the three, because
 * the interaction that named it does not either. Domain ids do not collide across kinds, so the
 * suffix is enough to find the row or the card that names one.
 *
 * The editor is part of the question because the documents tree names a scene too, and a drag has
 * to start on the surface that runs the gesture.
 */
export function resolveNamed(live: LiveAnchors, editor: AnchorHome, key: string): Resolution {
  const anchor = live.anchors.find(
    (entry) =>
      entry.editor === editor && entry.key.startsWith('item:') && entry.key.endsWith(`/${key}`),
  );
  if (!anchor) return { state: 'absent' };
  if ((live.offscreen ?? []).includes(anchor.key)) return { state: 'offscreen', anchor };
  return { state: 'ready', anchor };
}

/** One command's coverage, as the sweep and the doctree enumeration both write it. */
export interface AnchorRecord {
  id: string;
  editor: AnchorHome;
  /** The condition the record appeared under, so the map states its own coverage. */
  when?: string;
  supplies?: string[];
  /** Reached by opening the palette on the command's own form rather than by a direct click. */
  form?: boolean;
}

/** The map a tour plans against, folded from however many records name the same command. */
export function mapOf(records: readonly AnchorRecord[]): AnchorMap {
  const editorsFor: Record<string, AnchorHome[]> = {};
  for (const record of records) {
    const seen = (editorsFor[record.id] ??= []);
    if (!seen.includes(record.editor)) seen.push(record.editor);
  }
  return { editorsFor };
}
