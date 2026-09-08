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
import { composeTooltip } from 'pathux';
import type { PropValue } from '../../../src/shared/ipc.js';
import { menuAnchors } from '../doctree/doctree.js';
import { hitFor } from '../interactions/hittest.js';
import { centreOf } from '../../rules/ring.js';
import {
  HEADER,
  applyOffer,
  keyOf,
  type Action,
  type Anchor,
  type AnchorHome,
  type AnchorNode,
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
   */
  private present(node: AnchorNode, offer: Offer): void {
    const prior = this.pass.presented.get(node);
    if (prior === undefined) {
      this.pass.presented.set(node, offer);
      applyOffer(node as unknown as OfferNode, offer, composeTooltip);
      return;
    }
    if (prior.ok !== offer.ok || prior.tooltip !== offer.tooltip) {
      throw new Error(
        `${keyOf(offer)} shares a node with ${keyOf(prior)} and would present it differently`,
      );
    }
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
 * that, a step would resolve onto a widget that is no longer in the document.
 */
export function anchorSnapshot(open: readonly AnchorHome[]): LiveAnchors {
  const shown: readonly AnchorHome[] = [...open, HEADER];
  const anchors = liveAnchors().filter((anchor) => shown.includes(anchor.editor));
  return { anchors, open: shown, offscreen: anchors.filter(hidden).map((anchor) => anchor.key) };
}

/**
 * Whether an anchor has scrolled out of the window. Anything that is not drawn at all has already
 * been dropped by {@link drawn}. A pane's own clip is not consulted: a rect inside the window but
 * under another pane is a stacking question, and the pick oracle is what answers that.
 */
function hidden(anchor: Anchor): boolean {
  const rect = rectOf(anchor);
  if (!rect) return true;
  return (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  );
}

/** Where the ring goes. A `pick` anchor carries its own rect, since its geometry is the layout's. */
export function rectOf(anchor: Anchor): AnchorRect | undefined {
  if (anchor.via.kind === 'dom') return anchor.via.node.getBoundingClientRect();
  return anchor.via.node?.getBoundingClientRect() ?? anchor.via.rect;
}

/** One anchor as the sweep writes it down: everything but the node, which does not serialize. */
export interface AnchorDump {
  key: string;
  id: string;
  props: Record<string, PropValue>;
  then?: readonly Action[];
  supplies?: string[];
  form?: boolean;
  enabled: boolean;
  reason?: string;
  editor: AnchorHome;
  via: 'dom' | 'pick';
  nodeId?: string;
  rect?: AnchorRect;
}

export function dumpAnchors(): AnchorDump[] {
  return liveAnchors().map((anchor) => {
    const rect = rectOf(anchor);
    return {
      key  : anchor.key,
      id   : anchor.id,
      props: anchor.props,
      ...(anchor.then ? { then: anchor.then } : {}),
      ...(anchor.supplies ? { supplies: anchor.supplies } : {}),
      ...(anchor.form ? { form: true } : {}),
      enabled: anchor.enabled,
      ...(anchor.reason === undefined ? {} : { reason: anchor.reason }),
      editor: anchor.editor,
      via   : anchor.via.kind,
      ...(anchor.via.kind === 'pick' ? { nodeId: anchor.via.nodeId } : {}),
      ...(rect ? { rect: plain(rect) } : {}),
    };
  });
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
  const { x, y } = centreOf(rect);
  // A point outside the window has no hit test to give. That is the offscreen case, which
  // {@link hidden} already reports and the overlay answers by scrolling rather than by warning.
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { ok: true };
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

export function installAnchors(): void {
  window.__vnAnchors = {
    generation: () => generation,
    dump      : dumpAnchors,
    tree      : menuAnchors,
    strays    : strayAnchors,
  };
}
