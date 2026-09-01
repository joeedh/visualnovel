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
import type { EditorId } from '../../src/shared/editors.js';
import type { PropValue } from '../../src/shared/ipc.js';
import { menuAnchors } from './doctree.js';
import {
  commandKey,
  itemKey,
  type Action,
  type Anchor,
  type AnchorNode,
  type AnchorRect,
  type LiveAnchors,
  type Offer,
} from '../rules/anchors.js';

/** What one redraw of one part of one editor laid down. */
interface Pass {
  editor: EditorId;
  generation: number;
  anchors: Anchor[];
}

/** Rising with every pass, so a caller can tell a redraw from a repaint of the same widgets. */
let generation = 0;

const passes = new Map<string, Pass>();

/** Extra facts about an anchor that the offer itself cannot carry. */
export interface ActOptions {
  /**
   * The command a refused offer is about, where the rule's refusal names none. Ignored for an
   * offer that carries its own id.
   */
  about?: string;
  /** Prop names the click reads from the widget at commit time — a textarea, a typed id. */
  supplies?: string[];
  /**
   * What tells this control apart from another running the same command on the same pane — a
   * chunk key, a task hash. Appended to the key, so re-resolving by key lands on the same control.
   */
  on?: string;
  /** An `item:` key, for a control whose click publishes a selection rather than running a command. */
  key?: string;
  /** The `ui.*` fields an `item:` anchor's click publishes. */
  publishes?: Record<string, string>;
}

/**
 * Record one editor's anchors again from scratch.
 *
 * `part` separates the passes an editor makes independently — the asset editor redraws its bar and
 * its body from different places — so redrawing one does not discard the other's records.
 */
export function redrawing(editor: EditorId, part: string): AnchorPass {
  const id = `${editor}/${part}`;
  const pass: Pass = { editor, generation: ++generation, anchors: [] };
  passes.set(id, pass);
  return new AnchorPass(pass);
}

/** One pass over one part of one editor. Nothing outside may hold an {@link Anchor} across a frame. */
export class AnchorPass {
  constructor(private readonly pass: Pass) {}

  /**
   * Wire the click and record the anchor from one object, so the two cannot disagree. Returns the
   * node, so it still reads as a builder call.
   *
   * The node is left alone for a refused offer: a control the rule turned down has nothing to run,
   * and the caller greys it and shows `reason` as it already does.
   */
  act<N extends AnchorNode>(
    node: N,
    offer: Offer,
    run: (action: Action) => void,
    opts: ActOptions = {},
  ): N {
    if (offer.ok) {
      const action: Action = { id: offer.id, props: offer.props };
      // Assigned rather than added. A path.ux `Button` calls its own `onclick` on a touch pointer,
      // where the browser dispatches no click event for a listener to hear.
      (node as { onclick?: unknown }).onclick = () => run(action);
    }
    this.record(node, offer, opts);
    return node;
  }

  /**
   * Record an anchor without wiring anything, for a control whose click the caller installs for
   * reasons of its own — a box committed on blur, a field committed on Enter. The offer is still
   * the one object the click reads, so naming it here is what keeps the two together.
   */
  record(node: AnchorNode, offer: Offer, opts: ActOptions = {}): void {
    const id = offer.ok ? offer.id : (offer.id ?? opts.about);
    this.pass.anchors.push({
      key: opts.key ?? keyFor(id, opts.on),
      ...(id === undefined ? {} : { id }),
      props: offer.ok ? offer.props : {},
      ...(opts.supplies && opts.supplies.length > 0 ? { supplies: opts.supplies } : {}),
      enabled: offer.ok,
      ...(offer.ok ? {} : { reason: offer.reason }),
      ...(opts.publishes ? { publishes: opts.publishes } : {}),
      editor: this.pass.editor,
      via: { kind: 'dom', node },
    });
  }

  /**
   * Record where a subject is chosen. The tour rings one of these when the button it wanted acts
   * on whatever the pane is showing and the pane is showing something else.
   */
  item(node: AnchorNode, kind: string, key: string, publishes: Record<string, string>): void {
    this.pass.anchors.push({
      key: itemKey(kind, key),
      props: {},
      enabled: true,
      publishes,
      editor: this.pass.editor,
      via: { kind: 'dom', node },
    });
  }

  /**
   * Record a graph node, whose gesture the canvas's own `pick()` dispatches. The rule survives
   * here differently: the anchor is honest because the oracle calls the same `pick()` the pointer
   * does, not because one object feeds both sides.
   */
  pick(nodeId: string, offer: Offer, rect: AnchorRect | undefined, opts: ActOptions = {}): void {
    const id = offer.ok ? offer.id : (offer.id ?? opts.about);
    this.pass.anchors.push({
      key: opts.key ?? keyFor(id, opts.on),
      ...(id === undefined ? {} : { id }),
      props: offer.ok ? offer.props : {},
      ...(opts.supplies && opts.supplies.length > 0 ? { supplies: opts.supplies } : {}),
      enabled: offer.ok,
      ...(offer.ok ? {} : { reason: offer.reason }),
      editor: this.pass.editor,
      via: { kind: 'pick', nodeId, ...(rect ? { rect } : {}) },
    });
  }
}

let anonymous = 0;

/**
 * The key an anchor is re-resolved by. A control naming no command gets a fresh one, so two of
 * them never collide; two controls running the same command are told apart by `on`.
 */
function keyFor(id: string | undefined, on: string | undefined): string {
  if (id === undefined) return `anon:${++anonymous}`;
  return on === undefined ? commandKey(id) : `${commandKey(id)}#${on}`;
}

/** Every anchor drawn right now, in the order the passes laid them down. */
export function liveAnchors(): Anchor[] {
  return [...passes.values()].flatMap((pass) => pass.anchors);
}

/**
 * What the resolver reads. `open` comes from the caller because only the mesh knows how many panes
 * there are; the offscreen half is measured here, since it is a rect question.
 *
 * An editor no pane shows keeps its records — path.ux detaches an area on a tab switch and does
 * not redraw it on the way back — so they are dropped here rather than on the way out. Without
 * that, a step would resolve onto a widget that is no longer in the document.
 */
export function anchorSnapshot(open: readonly EditorId[]): LiveAnchors {
  const anchors = liveAnchors().filter((anchor) => open.includes(anchor.editor));
  return { anchors, open, offscreen: anchors.filter(hidden).map((anchor) => anchor.key) };
}

/**
 * Whether an anchor has scrolled out of the window or collapsed to nothing. A pane's own clip is
 * not consulted: a rect inside the window but under another pane is a stacking question, and the
 * pick oracle is what answers that.
 */
function hidden(anchor: Anchor): boolean {
  const rect = rectOf(anchor);
  if (!rect || rect.width === 0 || rect.height === 0) return true;
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
  return anchor.via.rect;
}

/** One anchor as the sweep writes it down: everything but the node, which does not serialize. */
export interface AnchorDump {
  key: string;
  id?: string;
  props: Record<string, PropValue>;
  supplies?: string[];
  enabled: boolean;
  reason?: string;
  editor: EditorId;
  via: 'dom' | 'pick';
  nodeId?: string;
  rect?: AnchorRect;
}

export function dumpAnchors(): AnchorDump[] {
  return liveAnchors().map((anchor) => {
    const rect = rectOf(anchor);
    return {
      key: anchor.key,
      ...(anchor.id === undefined ? {} : { id: anchor.id }),
      props: anchor.props,
      ...(anchor.supplies ? { supplies: anchor.supplies } : {}),
      enabled: anchor.enabled,
      ...(anchor.reason === undefined ? {} : { reason: anchor.reason }),
      editor: anchor.editor,
      via: anchor.via.kind,
      ...(anchor.via.kind === 'pick' ? { nodeId: anchor.via.nodeId } : {}),
      ...(rect ? { rect: plain(rect) } : {}),
    };
  });
}

/** A `DOMRect` does not survive `JSON.stringify`, so the sweep is handed a plain object. */
const plain = (rect: AnchorRect): AnchorRect => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height,
});

export function installAnchors(): void {
  window.__vnAnchors = { generation: () => generation, dump: dumpAnchors, tree: menuAnchors };
}
