import type { DocNodeKind } from './ipc.js';

/**
 * Every editor the shell can show, and the one place their names are written down.
 *
 * The list lives here rather than in the renderer because `view.*` runs in main like every other
 * command and needs it to declare its props — the catalog then offers the real names to the
 * palette, to CDP and to the agent. The renderer registers each editor class under the matching
 * area name, and the shell checks the two agree at boot.
 *
 * The header bar is deliberately absent because it is chrome rather than a place the author
 * navigates to.
 *
 * Each entry also declares what it will show for a clicked document-tree node — see
 * {@link EditorClaim}. An editor added without one is visibly claim-less in the same file that
 * names it, rather than silently unreachable from the tree.
 *
 * An entry with `pins` follows one selection field, and so can be pinned off it — see
 * {@link PinField}. An editor with no `pins` shows the same thing whatever is selected and has
 * nothing a pin could hold still.
 */
export const EDITORS = [
  {
    id: 'branches',
    title: 'Branches',
    what: 'the story graph as index cards',
    claims: (node: ClaimNode) => (node.kind === 'scene' ? 'secondary' : undefined),
  },
  {
    id: 'script',
    title: 'Script',
    what: "one scene's lines",
    claims: (node: ClaimNode) => (node.kind === 'scene' ? 'primary' : undefined),
    pins: 'sceneId',
  },
  { id: 'convo', title: 'Convo', what: 'the vnauthor conversation' },
  {
    id: 'timeline',
    title: 'Shot Coverage',
    what: 'a scene against the shots that illustrate it',
    claims: (node: ClaimNode) => {
      if (node.kind === 'shot') return 'primary';
      return node.kind === 'scene' ? 'secondary' : undefined;
    },
    // Pins the scene rather than the shot. A pinned Shot Coverage still highlights whichever shot is
    // selected; holding both still would make its own rows unclickable.
    pins: 'sceneId',
  },
  { id: 'tasklist', title: 'Tasks', what: 'the pipeline task list' },
  {
    id: 'taskgraph',
    title: 'Task Graph',
    what: 'the pipeline task graph',
    // The only editor that can show a slot, which is a place in the graph rather than bytes; every
    // other pane's subject is a file or a hash.
    claims: (node: ClaimNode) => (node.kind === 'slot' ? 'primary' : undefined),
  },
  // The Inspector claims nothing on purpose: its subject is `ui.taskHash`, and no document-tree
  // node names a task — a click that opened it would land on an empty pane.
  { id: 'inspector', title: 'Inspector', what: 'what is selected, in detail', pins: 'taskHash' },
  { id: 'play', title: 'Play', what: 'the runner' },
  {
    id: 'skills',
    title: 'Skills',
    what: 'the playbooks the agent can follow, and can write',
    // Listed before Wiki on purpose: both claim a `.md` file as `primary`, and the tie breaks on
    // this list's order. Skills wins because a `SKILL.md` opened in a plain text box would let an
    // author edit front-matter this pane answers for. Visibility is still ranked ahead of order.
    claims: (node: ClaimNode) => {
      if (node.kind === 'skill') return 'primary';
      return node.kind === 'file' && underSkills(node.path) ? 'primary' : undefined;
    },
  },
  {
    id: 'wiki',
    title: 'Wiki',
    what: 'one markdown document',
    // A sheet is edited here, and entity discovery means a character's sheet may itself live under
    // `wiki/**`, so an entity is claimed by the document it was found in and only if it has one.
    // A scene is not claimed here because prose has one editor and that is Script.
    claims: (node: ClaimNode) => {
      if (node.kind === 'wiki') return 'primary';
      if (node.kind === 'character' || node.kind === 'location') {
        return node.path === undefined ? undefined : 'primary';
      }
      return node.kind === 'file' && isTextPath(node.path) ? 'primary' : undefined;
    },
    pins: 'docPath',
  },
  { id: 'documents', title: 'Documents', what: "the project's documents and what links to them" },
  {
    id: 'asset',
    title: 'Asset',
    what: 'one generated asset, and the art notes behind it',
    claims: (node: ClaimNode) => (node.kind === 'asset' ? 'primary' : undefined),
    pins: 'assetHash',
  },
  { id: 'project', title: 'Project', what: 'project.yaml — art style, models, image params' },
  {
    id: 'systemprompt',
    title: 'System Prompt',
    what: 'the system prompt the agent will be sent',
    // Named but not listed, for the same reason as Setup: this is what the agent was told, a place
    // to check when a turn misbehaves rather than a place to work. It claims nothing because no
    // document-tree node names the prompt: three joined sources, one built in with no path.
    offered: false,
  },
  {
    id: 'onboarding',
    title: 'Setup',
    what: 'how to get a model key, and where yours are',
    // Reached once from the File menu and never again, so it is named but not listed. It claims
    // nothing because no document-tree node names an API key.
    offered: false,
  },
  {
    id: 'report',
    title: 'Debug Agent',
    what: 'a conversation with the agent that reads a conversation that went wrong',
    // Named but not listed: reached from Help ▸ Report a Difficult Agent… and from the card an API
    // fault raises. It claims nothing because its subject is a thread rather than a document.
    offered: false,
  },
] as const;

/**
 * How well an editor answers for a clicked document-tree node. Two named tiers rather than a
 * numeric score, so ranking stays a table lookup.
 */
export type ClaimTier = 'primary' | 'secondary';

/** The part of a document-tree node a claim may look at. */
export interface ClaimNode {
  kind: DocNodeKind;
  /** Workspace-relative. Absent for a grouping, and for an entity with no sheet. */
  path?: string;
  /**
   * The generation graph that draws this slot, for a `slot` node one graph binds. Main stamps it
   * where the tree is built, because a claim cannot read the project.
   */
  boundGraph?: string;
}

/** What an editor will show for a clicked document-tree node, and how well. */
export type EditorClaim = (node: ClaimNode) => ClaimTier | undefined;

/**
 * Where a project's skills live, workspace-relative and forward-slashed.
 *
 * Deliberately not `@vn/authoring`'s `PROJECT_SKILLS_DIR`, which is a `join()` and therefore
 * `.aiagent\skills` on Windows. This spelling lives here rather than in the renderer because a
 * claim needs it and this file is in the browser bundle, so one constant serves the claim, the
 * Skills pane's rules and both their tests.
 */
export const SKILLS_DIR = '.aiagent/skills';

/** Whether a workspace-relative path names something inside a skill. */
export function underSkills(path: string | undefined): boolean {
  return path !== undefined && path.startsWith(`${SKILLS_DIR}/`);
}

const TEXT_SUFFIXES = ['.md', '.txt', '.fountain', '.yaml', '.yml', '.json'] as const;

/**
 * Whether a path names something an editor can honestly show as text. In file mode a `.png` is a
 * `file` like any other, which is why a claim is a predicate over the node rather than a map from
 * its kind: pointing the wiki editor at one would have it read a binary.
 */
export function isTextPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  const lower = path.toLowerCase();
  return TEXT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** An editor's area name — the value `view.open`, `view.focus` and a stored layout all use. */
export type EditorId = (typeof EDITORS)[number]['id'];

/**
 * The selection field a pinnable editor follows, and stops following once pinned.
 *
 * One field per editor rather than a set, and it is always the field naming which thing the pane
 * is about. A pane that froze the rest of the selection with it would stop responding to its own
 * rows: Shot Coverage holds the scene and still follows the shot.
 */
export type PinField = 'sceneId' | 'docPath' | 'assetHash' | 'taskHash' | 'graphSlug';

/** What a pinned editor is holding, in the author's words. Used in the pin's own tooltip. */
export const PIN_NOUN: Record<PinField, string> = {
  sceneId: 'scene',
  docPath: 'document',
  assetHash: 'asset',
  taskHash: 'task',
  graphSlug: 'generation graph',
};

/**
 * Which field this editor can be pinned to, if any. The pin button, the struct fields that
 * remember it across a restart, and the frozen read all ask this one question, so an editor
 * becomes pinnable by declaring `pins` and nothing else.
 */
export function pinFieldOf(id: string): PinField | undefined {
  const editor = EDITORS.find((entry) => entry.id === id);
  return editor && 'pins' in editor ? editor.pins : undefined;
}

/**
 * The editors that claim anything, in `EDITORS` order — which is the tie-break the router falls
 * back on once visibility and tier have both tied, and what makes its ordering total.
 */
export const CLAIMS: readonly { id: EditorId; claims: EditorClaim }[] = EDITORS.flatMap((editor) =>
  'claims' in editor ? [{ id: editor.id, claims: editor.claims }] : [],
);

export const EDITOR_IDS: readonly EditorId[] = EDITORS.map((editor) => editor.id);

/**
 * The editors on offer: the ones the pane switcher lists and the View ▸ Editors submenu draws.
 *
 * An entry with `offered: false` is named but not listed — reachable from a menu entry, the
 * palette, CDP, the agent and a stored layout, and absent from the two places an author browses.
 * path.ux enforces the first half through `setAreaMenuFilter`, which the shell installs from this
 * list; the submenu is built from the same one, so the two ways of switching a pane cannot come
 * to disagree.
 *
 * `EDITOR_IDS` is deliberately not narrowed: `view.open`'s props, a stored layout's validation
 * and `editorNameProblems`'s boot check all still cover every editor, because an unoffered editor
 * going missing is exactly as broken as an offered one going missing.
 */
export const OFFERED_EDITOR_IDS: readonly EditorId[] = EDITORS.flatMap((editor) =>
  'offered' in editor && editor.offered === false ? [] : [editor.id],
);

/**
 * Whether an area is listed where an author browses — the predicate the shell installs as
 * path.ux's `setAreaMenuFilter`.
 *
 * Answers `true` for a name this list does not carry. The filter is installed application-wide and
 * sees every registered area, path.ux's own included, so it narrows exactly what this list names
 * and nothing else.
 */
export function isOfferedEditor(name: string): boolean {
  const editor = EDITORS.find((entry) => entry.id === name);
  return !editor || !('offered' in editor && editor.offered === false);
}

export function editorTitle(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.title ?? id;
}

/**
 * What an editor says on hover, wherever it is offered. The Editors menu and the pane tab that
 * switches to it show the same sentence, written once in `what`.
 */
export function editorTooltip(id: EditorId): string {
  const editor = EDITORS.find((entry) => entry.id === id);
  return `Show ${editor ? editor.what : editorTitle(id)} in this pane`;
}

/**
 * Where `view.open` puts an editor: in the pane you are in, in a new one beside it, or
 * `elsewhere` — the biggest pane other than the one asking, splitting only when there is no other.
 * A sidebar wants `elsewhere` because opening into itself would replace the sidebar.
 *
 * `window` is deliberately in the same list: to an author "put the script on the other monitor" is
 * the same sentence as "put it below", and only the app knows a monitor is a whole second
 * renderer. It never reaches the mesh — main answers it with `window.new` instead of pushing an
 * effect — so the renderer's own table excludes it by type rather than by check.
 *
 * `popup` is also not a place in the mesh: a floating window over it, with a titlebar to move it
 * by and a close button. Nothing the author arranged moves to make room for one, so it is where an
 * editor the app itself decided to show opens (the task list, when a run starts). It is in the
 * same list because to an author it is still an answer to "where does it go".
 */
export type OpenWhere =
  | 'here'
  | 'left'
  | 'right'
  | 'above'
  | 'below'
  | 'elsewhere'
  | 'window'
  | 'popup';

export const OPEN_WHERE = [
  'here',
  'left',
  'right',
  'above',
  'below',
  'elsewhere',
  'window',
  'popup',
] as const;

/**
 * Where this build's registry and this list disagree. An id in `EDITORS` that nothing registered
 * fails at the moment someone picks it out of the palette. A registered editor missing from here
 * never reaches `view.*` at all, yet still shows up in path.ux's own area-switcher menu, which
 * enumerates the area classes and knows nothing about this file.
 *
 * Pure so the shell's boot check can be tested. The shell supplies the registry's names, minus
 * chrome — the header is an editor by construction and deliberately absent from this list.
 */
export function editorNameProblems(registered: Iterable<string>): {
  unregistered: EditorId[];
  unnamed: string[];
} {
  const known = new Set(registered);
  const ids = new Set<string>(EDITOR_IDS);
  return {
    unregistered: EDITOR_IDS.filter((id) => !known.has(id)),
    unnamed: [...known].filter((name) => !ids.has(name)).sort(),
  };
}
