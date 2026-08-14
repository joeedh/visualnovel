import { Area, AreaFlags, ColumnFrame, UIBase, contextWrangler, nstructjs } from 'pathux';
import type { VnContext } from './context.js';
import type { ShellState } from './state.js';
import { closeStruct, type StructField } from './structfields.js';

/**
 * Base class for every editor in the shell: a column container inside the area's shadow
 * root, with path.ux's own header above it. Ports subclass this, not `Area`.
 */
export class VnEditor extends Area {
  container!: ColumnFrame;

  /**
   * The shell's UI state, as one narrowing rather than a type parameter: `Area<VnContext>`
   * makes the whole screen mesh generic, and its `ScreenArea`/`ScreenBorder` back-references
   * then stop being assignable in either direction.
   */
  get ui(): ShellState {
    return (this.ctx as VnContext).ui;
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

    this.header = this.makeHeader(this.container, true);
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
  cls.STRUCT = closeStruct(nstructjs.STRUCT.inherit(cls, VnEditor, structName), fields);
  nstructjs.register(cls);
  editors.set((cls.define() as { areaname: string }).areaname, cls);
}

VnEditor.STRUCT = closeStruct(nstructjs.STRUCT.inherit(VnEditor, Area, 'vn.VnEditor'));
nstructjs.register(VnEditor);
