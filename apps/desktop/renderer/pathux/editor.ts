import {
  Area,
  AreaFlags,
  ColumnFrame,
  UIBase,
  contextWrangler,
  nstructjs,
  type Container,
} from 'pathux';
import {
  EDITOR_IDS,
  PIN_NOUN,
  editorTooltip,
  pinFieldOf,
  type EditorId,
  type PinField,
} from '../../src/shared/editors.js';
import type { VnContext } from './context.js';
import { VN_ICONS, whenIconsSettled } from './icons.js';
import { pinnedView } from './pin.js';
import type { VnScreen } from './screen.js';
import type { ShellState } from './state.js';
import { closeStruct, type StructField } from './structfields.js';

/**
 * Base class for every editor in the shell: a column container inside the area's shadow
 * root, with path.ux's own header above it. Ports subclass this, not `Area`.
 */
export class VnEditor extends Area {
  container!: ColumnFrame;

  /**
   * Whether this pane has been pinned off the selection, and what it is holding. Plain fields
   * rather than accessors because they are struct fields: `registerEditor` declares both on a
   * pinnable editor, and `Area.loadSTRUCT` reads the whole struct with one `reader(this)`.
   */
  pinned = false;
  pinnedTo = '';

  /**
   * The shell's UI state, as one narrowing rather than a type parameter: `Area<VnContext>`
   * makes the whole screen mesh generic, and its `ScreenArea`/`ScreenBorder` back-references
   * then stop being assignable in either direction.
   *
   * A pinned pane reads a {@link pinnedView} of it instead — the same object behind it, one field
   * answered from the pin — so every `this.ui.sceneId` in every editor keeps working and nothing
   * has to learn a second way to ask what it is looking at.
   */
  get ui(): ShellState {
    const live = (this.ctx as VnContext).ui;
    const field = this.pinField;
    if (!this.pinned || !field) return live;
    return pinnedView(live, {
      field,
      get: () => this.pinnedTo,
      set: (value) => {
        this.pinnedTo = value;
      },
    });
  }

  /** Which selection field this pane can be pinned to — `undefined` for one that follows none. */
  get pinField(): PinField | undefined {
    const cls = this.constructor as unknown as { define(): { areaname: string } };
    return pinFieldOf(cls.define().areaname);
  }

  /**
   * The pin, for a pinnable editor's own header row. A toggle rather than two buttons, drawn as
   * the pin icon while the sheet has one and as a checkbox until it does, and it says what it
   * *does* rather than what it is called — "Pin" alone tells an author nothing about following.
   *
   * Pinning snapshots what the pane is on right now, which is the only value that could be meant;
   * unpinning is a jump back to whatever the rest of the app is looking at, and the editor's own
   * `update()` notices that the way it notices any other selection change.
   */
  protected pinToggle(row: Container): void {
    const field = this.pinField;
    if (!field) return;

    // Its own row, so it can be drawn a second time without disturbing the bar around it: a
    // header built once — the wiki's — is built before the icon sheet has decoded, and would
    // otherwise keep the text fallback for the life of the app.
    const holder = row.row();
    this.drawPin(holder, field);
    if (VN_ICONS.pin < 0)
      whenIconsSettled(() => {
        holder.clear();
        this.drawPin(holder, field);
        holder.flushUpdate();
      });
  }

  private drawPin(row: Container, field: PinField): void {
    const noun = PIN_NOUN[field];

    const say = (on: boolean): string =>
      on
        ? `Pinned to this ${noun}. Click to follow the selection again.`
        : `Keep this pane on this ${noun} while the rest of the app moves on.`;

    const toggle =
      VN_ICONS.pin >= 0
        ? row.iconcheck(undefined, VN_ICONS.pin)
        : row.check(undefined, `pin ${noun}`);
    toggle.checked = this.pinned;
    toggle.description = say(this.pinned);
    toggle.on_change = (next: unknown) => {
      const on = next === true;
      if (on === this.pinned) return;
      // Read before the flag flips: `this.ui` is the live state while `pinned` is still false,
      // and the pin has to start life holding what the pane is already showing.
      if (on) this.pinnedTo = this.ui[field];
      this.pinned = on;
      toggle.description = say(on);
      // The pin is saved with the pane, and nothing about the mesh's *shape* moved — so it has
      // to say so itself, the way the documents editor's mode does. Through the screen's own
      // hook rather than `persist.layoutChanged`, because persistence already imports this
      // module for `knownAreaNames` and the arrow between the two may only go one way.
      ((this.ctx as VnContext).screen as VnScreen | undefined)?.onLayoutChange?.();
      this.announce();
    };
  }

  /**
   * Wake every widget bound to `ui.*`, after an editor has changed one. Reached through the
   * context rather than the bridge: an editor exists before `installBridge` runs, and one that
   * publishes a selection during its first `update()` would otherwise throw.
   */
  announce(): void {
    (this.ctx as VnContext).api.notifyChange();
  }

  override push_ctx_active() {
    contextWrangler.updateLastRef(this.constructor, this);
    contextWrangler.push(this.constructor, this);
  }

  override pop_ctx_active() {
    contextWrangler.pop(this.constructor, this);
  }

  override init() {
    super.init();

    this.container = UIBase.createElement<ColumnFrame>('colframe-x');
    this.container.ctx = this.ctx;
    this.shadow.appendChild(this.container);

    this.header = this.makeHeader(this.container, this.wantsNoteArea);
  }

  /**
   * Whether this editor's header carries a note frame. False everywhere but the menu bar:
   * `sendNote` broadcasts to **every** `noteframe-x` on screen, so with one per editor a single
   * sentence appeared thirteen times at once. Notifications have one home now — the bar, beside
   * the bell that keeps them — and `getNoteFrames` finds exactly one place to put them.
   */
  protected get wantsNoteArea(): boolean {
    return false;
  }

  /**
   * Register a subscription that follows this editor on and off the screen.
   *
   * path.ux calls `init()` **once** and `remove()` — and so `on_remove()` — every time a tab
   * switch detaches the editor, without ever calling `init()` again when the tab comes back. A
   * watcher unsubscribed in a hand-written `on_remove` is therefore gone for good: the pane draws
   * whatever it held the moment it was first hidden and never hears another word, which is why a
   * document tree stopped following the agent after the author looked at anything else. Watches
   * registered here are dropped on the way out and re-made on the way back in, and `onReturn`
   * runs on the way back so the pane catches up on what it missed while it was off screen.
   *
   * `arm` is called immediately, so this belongs in `init()` like the subscription it replaces.
   */
  protected watch(arm: () => () => void, onReturn?: () => void): void {
    this.watches.push({ arm, onReturn, off: arm() });
  }

  private watches: { arm: () => () => void; onReturn?: () => void; off?: () => void }[] = [];

  override on_remove(): void {
    for (const watch of this.watches) {
      watch.off?.();
      watch.off = undefined;
    }
    super.on_remove();
  }

  override on_area_active(): void {
    super.on_area_active();
    // Also the first activation, where every watch is already armed and this is a no-op.
    for (const watch of this.watches) {
      if (watch.off) continue;
      watch.off = watch.arm();
      watch.onReturn?.();
    }
  }

  /**
   * Put a raw DOM surface — a play stage, a graph canvas — under the column container, filling
   * what the header leaves. It cannot go through `container.appendChild`: that routes a `UIBase`
   * into the container's shadow root but hands anything else to `super.appendChild`, which lands
   * it in the **light** DOM, and a path.ux widget has no `<slot>`. The node is then in the tree,
   * findable, clickable from script, and never laid out or drawn.
   */
  protected appendSurface(element: HTMLElement): void {
    this.container.style['height'] = '100%';
    element.style.flex = '1 1 auto';
    element.style.minHeight = '0px';
    this.container.shadow.appendChild(element);
  }

  /**
   * Give a surface its own stylesheet, inside the shadow root {@link appendSurface} mounts into.
   * Document rules do not cross that boundary — only custom properties inherit — so a surface
   * whose look needs real CSS carries the sheet with it. `:hover`, `::after` and `:has()` have no
   * inline form at all, so this is not a convenience: the strip's auto-growing editor is a
   * pseudo-element and its drag handles are hover states.
   */
  protected adoptStyle(css: string): void {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const shadow = this.container.shadow as ShadowRoot;
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  }
}

const editors = new Map<string, typeof VnEditor>();

/**
 * Every area name this build can build. path.ux has no public view of its own registry, and
 * `restoreLayout` needs one: a stored layout naming an editor a later build **removed** hits
 * the same silent fallback `registerEditor` describes, so the shell checks the names itself.
 */
export function knownAreaNames(): ReadonlySet<string> {
  return new Set(editors.keys());
}

/**
 * The area names an author can actually switch a pane to — everything above except chrome.
 * `AreaFlags.HIDDEN` is the flag path.ux's own area-switcher skips, so it is the same line the
 * boot check has to draw: the header bar is registered like any editor and named in no list.
 */
export function switchableAreaNames(): string[] {
  return [...editors]
    .filter(([, cls]) => !(((cls.define() as { flag?: number }).flag ?? 0) & AreaFlags.HIDDEN))
    .map(([name]) => name);
}

/**
 * The class registered under an area name. `view.open` names an editor in the vocabulary
 * `shared/editors.ts` writes down, and this is where that name becomes something to switch to.
 */
export function editorClass(areaname: string): typeof VnEditor | undefined {
  return editors.get(areaname);
}

/**
 * Register an editor: its area name with path.ux, and its `STRUCT` with nstructjs under a
 * **written-down** name. Both halves have to happen and `structName` is the reason this is a
 * function — `STRUCT.inherit` defaults to `cls.name`, which esbuild minifies to a letter or
 * two that changes with the build. A layout saved by one build then names a struct the next
 * build does not have, and `ScreenArea.loadSTRUCT` does not fail loudly: it falls back to the
 * *first registered* area class, so every remembered pane comes back as the same editor.
 *
 * `fields` is what a pane remembers of its own — one declaration per line of nstructjs, spliced
 * inside the struct the parent's fields already fill. Anything declared here must exist on the
 * instance before a save, so give it a class-field default; `Area.loadSTRUCT` reads the whole
 * struct with one `reader(this)`, so nothing else is needed to get it back.
 */
export function registerEditor(
  cls: typeof VnEditor,
  structName: string,
  fields: readonly StructField[] = [],
): void {
  VnEditor.register(cls);
  const areaname = (cls.define() as { areaname: string }).areaname;
  // The pin's two fields are spliced in from the one declaration in `shared/editors.ts` rather
  // than typed into five `registerEditor` calls, for the reason the struct name and the tab's
  // sentence are: an editor becomes pinnable by declaring `pins`, and a pin that survived a
  // restart in four panes but not the fifth would be the kind of gap nobody thinks to test for.
  const pin: StructField[] = pinFieldOf(areaname) ? ['pinned : bool', 'pinnedTo : string'] : [];
  cls.STRUCT = closeStruct(nstructjs.STRUCT.inherit(cls, VnEditor, structName), [
    ...fields,
    ...pin,
  ]);
  nstructjs.register(cls);

  editors.set(areaname, cls);
  describe(cls, areaname);
}

/**
 * Give the class's `define()` the sentence `shared/editors.ts` already writes down, which is what
 * path.ux's docker puts on the pane tab. It is spliced here, like the struct name above, rather
 * than typed into twelve `define()`s: the Editors menu offers the same sentence from the same
 * list, and a tab that said something else would be two answers to one question. Chrome is in no
 * list and gets none — the header bar has no tab to hover.
 */
function describe(cls: typeof VnEditor, areaname: string): void {
  if (!(EDITOR_IDS as readonly string[]).includes(areaname)) return;

  const description = editorTooltip(areaname as EditorId);
  const define = cls.define.bind(cls);
  cls.define = () => ({ ...define(), description });
}

VnEditor.STRUCT = closeStruct(nstructjs.STRUCT.inherit(VnEditor, Area, 'vn.VnEditor'));
nstructjs.register(VnEditor);
