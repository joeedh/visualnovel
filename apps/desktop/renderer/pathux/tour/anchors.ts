/**
 * The anchor registry: which invocation each thing on screen would run, recorded as the widget is
 * wired rather than described afterwards.
 *
 * {@link act} takes one `Offer` and uses it for both halves — the click it installs and the record
 * it keeps — so a rewired control cannot leave a stale anchor behind. Everything a rebuild draws
 * is recorded in one pass and the previous pass is dropped whole, because `rebuildBody()` does
 * `surface.textContent = ''` and a reference held across a frame is a dangling pointer.
 *
 * Exposed as `window.__vnAnchors` for the sweep and for DevTools. Unlike `window.__vnDebug` this
 * ships in production, because the tour reads it at runtime.
 */
import { composeTooltip, keymap as KEYS, reverse_keymap, walkWidgets, type HotKey } from 'pathux';
import * as nstructjs from 'nstructjs';
import { StdUXMeta, getMeta, type MetaOwner } from 'pathux-meta';
import type { PopupHome } from '../../../src/shared/editors.js';
import { menuRecords } from '../../rules/menus.js';
import { SHORTCUTS, comboOf, type ShortcutScope } from '../../rules/shortcuts.js';
import { hitFor, up } from '../interactions/hittest.js';
import { centreOf } from '../../rules/ring.js';
import {
  HEADER,
  applyOffer,
  keyOf,
  writeTag,
  type Action,
  type Anchor,
  type AnchorHome,
  type AnchorNode,
  type AnchorRecord,
  type AnchorRect,
  type LiveAnchors,
  type Offer,
  type OfferNode,
} from '../../rules/anchors.js';

/** What one redraw of one part of one editor laid down. */
interface Pass {
  editor: AnchorHome;
  generation: number;
  anchors: Anchor[];
  /** The first offer presented on each node, so a second one on the same node must agree with it. */
  presented: Map<AnchorNode, Offer>;
}

/** Rising with every pass, so a caller can tell a redraw from a repaint of the same widgets. */
let generation = 0;

const passes = new Map<string, Pass>();

/** The toolbar popups up right now. Each is an anchor home only while it is open. */
const openPopups = new Set<PopupHome>();

/** A toolbar popup came up, so its passes count and a step on one of its controls can ring. */
export function popupOpened(popup: PopupHome): void {
  openPopups.add(popup);
}

/**
 * A toolbar popup went away, by whichever route. Its passes go with it, so a step on one of its
 * controls resolves `popup-closed` and rings the opener instead of a widget no longer drawn.
 */
export function popupClosed(popup: PopupHome): void {
  openPopups.delete(popup);
  for (const [id, pass] of passes) if (pass.editor === popup) passes.delete(id);
}

/**
 * Record one editor's anchors again from scratch.
 *
 * `part` separates the passes an editor makes independently — the asset editor redraws its bar and
 * its body from different places — so redrawing one does not discard the other's records.
 */
export function redrawing(editor: AnchorHome, part: string): AnchorPass {
  const id = `${editor}/${part}`;
  const pass: Pass = { editor, generation: ++generation, anchors: [], presented: new Map() };
  passes.set(id, pass);
  return new AnchorPass(pass);
}

/** One pass over one part of one editor. Nothing outside may hold an {@link Anchor} across a frame. */
export class AnchorPass {
  constructor(private readonly pass: Pass) {}

  /**
   * Wire the click, present the offer on the node and record the anchor from one object, so the
   * three cannot disagree. Returns the node, so it still reads as a builder call.
   *
   * A refused offer wires nothing: the node is greyed with the refusal above its tooltip, and a
   * control the rule turned down has nothing to run.
   */
  act<N extends AnchorNode>(node: N, offer: Offer, run: (action: Action) => void): N {
    if (offer.ok) {
      const action: Action = { id: offer.id, props: offer.props };
      // Assigned rather than added. A path.ux `Button` calls its own `onclick` on a touch pointer,
      // where the browser dispatches no click event for a listener to hear.
      (node as { onclick?: unknown }).onclick = () => run(action);
    }
    this.record(node, offer);
    return node;
  }

  /**
   * Present the offer and record the anchor without wiring a click, for a control whose click the
   * caller installs for reasons of its own — a box committed on blur, a field committed on Enter.
   * The offer is still the one object the click reads, so naming it here is what keeps the two
   * together.
   */
  record<N extends AnchorNode>(node: N, offer: Offer): N {
    this.present(node, offer);
    this.pass.anchors.push({ ...this.anchorOf(offer), via: { kind: 'dom', node } });
    return node;
  }

  /**
   * Present the offer on a graph card and record the anchor, for a card whose gesture the canvas's
   * own `pick()` dispatches rather than the card. `box` is the card's own element, kept for its
   * rect: it moves with every pan and zoom, so a rect copied at draw time would be wrong by the
   * next frame.
   */
  pick(nodeId: string, box: AnchorNode, offer: Offer): void {
    this.present(box, offer);
    this.pass.anchors.push({ ...this.anchorOf(offer), via: { kind: 'pick', nodeId, node: box } });
  }

  /** The record an offer makes, short of where it is drawn. */
  private anchorOf(offer: Offer): Omit<Anchor, 'via'> {
    const supplies = offer.supplies ?? [];
    return {
      key  : keyOf(offer),
      id   : offer.id,
      props: offer.ok ? offer.props : {},
      ...(offer.ok && offer.then !== undefined ? { then: offer.then } : {}),
      ...(supplies.length > 0 ? { supplies: [...supplies] } : {}),
      ...(offer.form ? { form: true } : {}),
      enabled: offer.ok,
      ...(offer.ok ? {} : { reason: offer.refusal.reason }),
      editor: this.pass.editor,
    };
  }

  /**
   * A node may carry several offers — a menu button whose rows run different commands — only
   * while they present the same way, so the second one cannot silently overwrite the first.
   *
   * The tag is written on every offer, and only the first one this pass presents replaces the
   * tools an earlier pass left there.
   */
  private present(node: AnchorNode, offer: Offer): void {
    const prior = this.pass.presented.get(node);
    if (prior !== undefined && (prior.ok !== offer.ok || prior.tooltip !== offer.tooltip)) {
      throw new Error(
        `${keyOf(offer)} shares a node with ${keyOf(prior)} and would present it differently`,
      );
    }
    const first = prior === undefined;
    if (first) {
      this.pass.presented.set(node, offer);
      applyOffer(node as unknown as OfferNode, offer, composeTooltip);
    }
    writeTag(node as unknown as MetaOwner, offer, this.pass.editor, first);
  }
}

/** Every anchor drawn right now, in the order the passes laid them down. */
export function liveAnchors(): Anchor[] {
  return [...passes.values()].flatMap((pass) => pass.anchors).filter(drawn);
}

/**
 * The anchor a key names right now. Nothing may hold an {@link Anchor} across a frame, so the
 * overlay keeps the key and asks again — every frame for the rect, which a scroll moves.
 */
export function anchorFor(key: string): Anchor | undefined {
  return liveAnchors().find((anchor) => anchor.key === key);
}

/**
 * Whether the node an anchor points at is on screen at all — in the document, and drawn with a
 * size. A control that comes and goes without a redraw of its whole pass (a rename box, a Stop
 * button hidden between turns) is not scrolled away, it is not there, and the two get different
 * answers: the overlay scrolls to the first and must not try to scroll to the second.
 */
function drawn(anchor: Anchor): boolean {
  const node = anchor.via.kind === 'dom' ? anchor.via.node : anchor.via.node;
  if (!node) return true;
  if (typeof Node !== 'undefined' && node instanceof Node && !node.isConnected) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * What the resolver reads. `open` comes from the caller because only the mesh knows how many panes
 * there are; the offscreen half is measured here, since it is a rect question.
 *
 * An editor no pane shows keeps its records — path.ux detaches an area on a tab switch and does
 * not redraw it on the way back — so they are dropped here rather than on the way out. Without
 * that, a step would resolve onto a widget that is no longer in the document. A toolbar popup is
 * open while it is up and has no records once it is not, so it is in the set on its own say-so.
 */
export function anchorSnapshot(open: readonly AnchorHome[]): LiveAnchors {
  const shown: readonly AnchorHome[] = [...open, HEADER, ...openPopups];
  const anchors = liveAnchors().filter((anchor) => shown.includes(anchor.editor));
  return { anchors, open: shown, offscreen: anchors.filter(hidden).map((anchor) => anchor.key) };
}

/**
 * Whether an anchor has scrolled out of the window, or its middle out of a scrolling ancestor such
 * as a popup's list. Anything that is not drawn at all has already been dropped by {@link drawn}.
 * A pane's own clip is not consulted: a rect inside the window but under another pane is a
 * stacking question, and the pick oracle is what answers that.
 */
function hidden(anchor: Anchor): boolean {
  const rect = rectOf(anchor);
  if (!rect) return true;
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  ) {
    return true;
  }
  const node = anchor.via.kind === 'dom' ? anchor.via.node : undefined;
  if (typeof Node === 'undefined' || !(node instanceof Node)) return false;
  return scrolledOut(node, centreOf(rect));
}

/**
 * Whether a scrolling ancestor of a node clips the point, which is where a click or a ring would
 * go. Ascends through shadow roots, since a popup's list is several roots above its rows.
 */
function scrolledOut(node: Node, point: { x: number; y: number }): boolean {
  for (let parent = up(node); parent; parent = up(parent)) {
    if (!(parent instanceof Element) || parent.scrollHeight <= parent.clientHeight) continue;
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const box = parent.getBoundingClientRect();
    if (point.y < box.top || point.y >= box.bottom || point.x < box.left || point.x >= box.right) {
      return true;
    }
  }
  return false;
}

/** Where the ring goes. A `pick` anchor carries its own rect, since its geometry is the layout's. */
export function rectOf(anchor: Anchor): AnchorRect | undefined {
  if (anchor.via.kind === 'dom') return anchor.via.node.getBoundingClientRect();
  return anchor.via.node?.getBoundingClientRect() ?? anchor.via.rect;
}

/**
 * One anchor as the sweep reads it: the tag its control carries, plus the two things the tag has
 * nowhere to put — the key the resolver re-finds it by, and where the ring goes.
 *
 * `tag` is a `StdUXMeta` through `nstructjs.writeJSON`, so what the offer said travels as the
 * type both tiers write rather than as a second hand-kept interface. `null` where the control
 * carries no tag at all, which is a defect the sweep reports.
 */
export interface SweptAnchor {
  key: string;
  editor: AnchorHome;
  tag: unknown;
  via: 'dom' | 'pick';
  nodeId?: string;
  rect?: AnchorRect;
}

/**
 * The tag on the node this anchor points at, narrowed to the one tool this anchor's own offer
 * put there. A node presenting two offers carries both, and each anchor is about one of them;
 * the name stays the node's, since two offers on one node are still one control.
 */
function tagJSON(anchor: Anchor): unknown {
  const node = anchor.via.node;
  const tag = node === undefined ? undefined : getMeta(node as unknown as MetaOwner, StdUXMeta);
  if (tag === undefined) return null;
  const one = tag.copy();
  const mine = one.tools.find((tool) => tool.toolPath === anchor.id) ?? one.tools[0];
  one.tools = mine === undefined ? [] : [mine];
  return nstructjs.writeJSON(one);
}

export function dumpAnchors(): SweptAnchor[] {
  return liveAnchors().map((anchor) => {
    const rect = rectOf(anchor);
    return {
      key   : anchor.key,
      editor: anchor.editor,
      tag   : tagJSON(anchor),
      via   : anchor.via.kind,
      ...(anchor.via.kind === 'pick' ? { nodeId: anchor.via.nodeId } : {}),
      ...(rect ? { rect: plain(rect) } : {}),
    };
  });
}

/**
 * Every named control the document holds, found by walking it rather than by asking the passes.
 *
 * The second opinion on the tag layer's reach. `walkWidgets` descends `childNodes` and then a
 * `UIBase`'s shadow, so a control mounted in a shadow root that is not a widget's would be
 * invisible to it; the sweep compares this list with what the passes anchored and reports the
 * difference. The whole document rather than the screen, since the header and the three toolbar
 * popups are not panes.
 *
 * Only this app's writer fills `widgetPath`, so a tag path.ux's own builders left on a button is
 * skipped rather than reported as an anchor nothing claims.
 */
export function walkedAnchors(): string[] {
  const named = new Set<string>();
  for (const owner of walkWidgets(document)) {
    const path = getMeta(owner, StdUXMeta)?.widgetPath;
    if (path !== undefined) named.add(path);
  }
  return [...named].sort();
}

/** A `DOMRect` does not survive `JSON.stringify`, so the sweep is handed a plain object. */
const plain = (rect: AnchorRect): AnchorRect => ({
  left  : rect.left,
  top   : rect.top,
  right : rect.right,
  bottom: rect.bottom,
  width : rect.width,
  height: rect.height,
});

/**
 * How one editor answers whether a screen point resolves to the graph node it names. The editor
 * registers its canvas's own `pickAt`, so the oracle and the pointer read the same geometry.
 */
export type PickOracle = (nodeId: string, x: number, y: number) => boolean;

const oracles = new Map<AnchorHome, PickOracle>();

/** Register an editor's pick oracle. Replaces whatever was registered for that editor. */
export function pickOracle(editor: AnchorHome, oracle: PickOracle): void {
  oracles.set(editor, oracle);
}

/**
 * Whether a click in the middle of this anchor would reach it, with the box of whatever the DOM
 * hit test found there. The two flavours need different oracles: a `pick` anchor sits on a layer
 * that takes no pointer events, so a click on its box lands on the canvas by design, and a DOM
 * oracle would report every graph card as a stray, correctly and uselessly.
 *
 * The result is `ok` for a `pick` anchor whose editor registered no oracle, because only that
 * canvas can tell and it was never asked. It is `ok` for a greyed control too, which commonly
 * takes no pointer events, so the hit test would report a miss on a click nobody will make.
 */
export function landsOn(anchor: Anchor): { ok: boolean; hit?: AnchorRect } {
  const rect = rectOf(anchor);
  if (!anchor.enabled || !rect) return { ok: true };
  // An anchor scrolled out of the window or out of its list has no hit test to give. That is the
  // offscreen case, which {@link hidden} reports and the overlay answers by scrolling.
  if (hidden(anchor)) return { ok: true };
  const { x, y } = centreOf(rect);
  if (anchor.via.kind === 'pick') {
    const oracle = oracles.get(anchor.editor);
    return { ok: oracle ? oracle(anchor.via.nodeId, x, y) : true };
  }
  const node = anchor.via.node;
  if (typeof Node === 'undefined' || !(node instanceof Node)) return { ok: true };
  const { ok, hit } = hitFor(node, x, y);
  return { ok, ...(hit ? { hit: hit.getBoundingClientRect() } : {}) };
}

/**
 * Every anchor whose ring would not land on the thing it names. Empty is the healthy answer;
 * anything in it is a control a click would miss, which the sweep reports rather than reconciles.
 */
export function strayAnchors(): string[] {
  return liveAnchors()
    .filter((anchor) => !landsOn(anchor).ok)
    .map((anchor) => `${anchor.editor} ${anchor.key}`);
}

/**
 * Click the control an anchor names, as the sweep does to open each toolbar popup. Answers whether
 * the key named something drawn; a `pick` anchor's box takes no pointer events and is not pressed.
 */
export function press(key: string): boolean {
  const anchor = anchorFor(key);
  if (!anchor || anchor.via.kind !== 'dom') return false;
  const node = anchor.via.node as { click?: () => void };
  if (typeof node.click !== 'function') return false;
  node.click();
  return true;
}

/**
 * Every menu entry as a record, which the sweep writes beside what the panes drew. Derived from
 * the menu table rather than from a menu on screen, so no pane has to be opened.
 */
export function menuAnchors(): AnchorRecord[] {
  const seen = new Set<string>();
  const anchors: AnchorRecord[] = [];
  for (const record of menuRecords()) {
    // The same row over several situations makes one anchor, since these four fields are all
    // an anchor keeps
    const key = `${record.editor}\0${record.when}\0${record.id}\0${record.form ? 'form' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      id    : record.id,
      editor: record.editor as AnchorHome,
      when  : record.when,
      ...(record.form ? { form: true } : {}),
    });
  }
  return anchors;
}

/** The live keymap of each scope that has installed one, read when the sweep asks. */
const liveKeymaps = new Map<ShortcutScope, () => readonly HotKey[] | undefined>();

/**
 * Let the sweep compare a scope's live keymap with the table. A thunk rather than the keymap,
 * since a pane may build a new one; the last pane of a scope to register is the one read.
 */
export function watchKeymap(scope: ShortcutScope, keys: () => readonly HotKey[] | undefined): void {
  liveKeymaps.set(scope, keys);
}

/** One live scope against the table: the combos each has that the other lacks. */
export interface ScopeReport {
  scope: string;
  /** Combos the table lists that the live keymap does not bind. */
  missing: string[];
  /** Combos the live keymap binds that the table does not list. */
  extra: string[];
}

/**
 * Every watched scope against `SHORTCUTS`, compared by key code and modifiers so a spelling of
 * the same key cannot read as a difference. Advisory: the sweep prints it and gates nothing.
 */
export function shortcutReport(): ScopeReport[] {
  const combo = (key: number, mods: readonly string[]) =>
    `${[...mods]
      .map((mod) => mod.toLowerCase())
      .sort()
      .join('+')} ${key}`;
  const report: ScopeReport[] = [];
  for (const [scope, keys] of liveKeymaps) {
    const listed = new Map(
      SHORTCUTS.filter((entry) => entry.scope === scope).map((entry) => [
        combo((KEYS as unknown as Record<string, number>)[entry.key] ?? -1, entry.mods),
        comboOf(entry),
      ]),
    );
    const live = new Map(
      // A KeyMap is an Array subclass whose constructor takes hotkeys, so map() runs on a copy
      [...(keys() ?? [])].map((hotkey) => [
        combo(hotkey.key, hotkey.mods),
        comboOf({
          key : (reverse_keymap[hotkey.key] ?? String(hotkey.key)) as never,
          mods: hotkey.mods.map((mod) => mod.toLowerCase() as never),
        }),
      ]),
    );
    report.push({
      scope,
      missing: [...listed].filter(([key]) => !live.has(key)).map(([, name]) => name),
      extra  : [...live].filter(([key]) => !listed.has(key)).map(([, name]) => name),
    });
  }
  return report;
}

export function installAnchors(): void {
  window.__vnAnchors = {
    generation: () => generation,
    dump      : dumpAnchors,
    walk      : walkedAnchors,
    menus     : menuAnchors,
    strays    : strayAnchors,
    shortcuts : shortcutReport,
    press,
  };
}
