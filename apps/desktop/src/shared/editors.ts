import type { DocNodeKind } from './ipc.js';

/**
 * Every editor the shell can show, and the one place their names are written down.
 *
 * It is here rather than in the renderer because `view.*` runs in main like every other command
 * and needs the list to declare its props — the catalog then offers the real names to the
 * palette, to CDP and to the agent. The renderer registers each editor class under the matching
 * area name, and the shell checks the two agree at boot.
 *
 * The header bar is deliberately absent: it is chrome, not somewhere the author navigates to.
 *
 * Each entry also declares what it will show for a clicked document-tree node — see
 * {@link EditorClaim}. An editor added without one is visibly claim-less in the same file that
 * names it, rather than silently unreachable from the tree.
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
  },
  { id: 'convo', title: 'Convo', what: 'the vnauthor conversation' },
  {
    id: 'timeline',
    title: 'Coverage',
    what: 'a scene against the shots that illustrate it',
    claims: (node: ClaimNode) => {
      if (node.kind === 'shot') return 'primary';
      return node.kind === 'scene' ? 'secondary' : undefined;
    },
  },
  { id: 'tasklist', title: 'Tasks', what: 'the pipeline task list' },
  {
    id: 'taskgraph',
    title: 'Task Graph',
    what: 'the pipeline task graph',
    // The only editor with anything to say about a picture that has no bytes: a slot is a place in
    // the graph, and every other pane's subject is a file or a hash.
    claims: (node: ClaimNode) => (node.kind === 'slot' ? 'primary' : undefined),
  },
  // The Inspector claims nothing on purpose: its subject is `ui.taskHash`, and no document-tree
  // node names a task — a click that opened it would land on an empty pane.
  { id: 'inspector', title: 'Inspector', what: 'what is selected, in detail' },
  { id: 'play', title: 'Play', what: 'the runner' },
  {
    id: 'wiki',
    title: 'Wiki',
    what: 'one markdown document',
    // A sheet is edited here, and entity discovery means a character's may itself live under
    // `wiki/**` — so an entity is claimed by the document it was found in, and only if it has
    // one. A scene is not: prose has one editor and it is Script.
    claims: (node: ClaimNode) => {
      if (node.kind === 'wiki') return 'primary';
      if (node.kind === 'character' || node.kind === 'location') {
        return node.path === undefined ? undefined : 'primary';
      }
      return node.kind === 'file' && isTextPath(node.path) ? 'primary' : undefined;
    },
  },
  { id: 'documents', title: 'Documents', what: "the project's documents and what links to them" },
  {
    id: 'asset',
    title: 'Asset',
    what: 'one generated asset, and the art notes behind it',
    claims: (node: ClaimNode) => (node.kind === 'asset' ? 'primary' : undefined),
  },
  { id: 'project', title: 'Project', what: 'project.yaml — art style, models, image params' },
] as const;

/**
 * How well an editor answers for a clicked document-tree node. Two named tiers rather than a
 * number: a score accumulates ad-hoc tie-breakers until nobody can say why a click landed where
 * it did, whereas this is a table lookup.
 */
export type ClaimTier = 'primary' | 'secondary';

/** The part of a document-tree node a claim may look at. */
export interface ClaimNode {
  kind: DocNodeKind;
  /** Workspace-relative. Absent for a grouping, and for an entity with no sheet. */
  path?: string;
}

/** What an editor will show for a clicked document-tree node, and how well. */
export type EditorClaim = (node: ClaimNode) => ClaimTier | undefined;

const TEXT_SUFFIXES = ['.md', '.txt', '.fountain', '.yaml', '.yml', '.json'] as const;

/**
 * Whether a path names something an editor can honestly show as text. A claim is a predicate over
 * the node rather than a map from its kind precisely for this: in file mode a `.png` is a `file`
 * like any other, and pointing the wiki editor at one would have it read a binary.
 */
export function isTextPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  const lower = path.toLowerCase();
  return TEXT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** An editor's area name — the value `view.open`, `view.focus` and a stored layout all use. */
export type EditorId = (typeof EDITORS)[number]['id'];

/**
 * The editors that claim anything, in `EDITORS` order — which is the tie-break the router falls
 * back on once visibility and tier have both tied, and what makes its ordering total.
 */
export const CLAIMS: readonly { id: EditorId; claims: EditorClaim }[] = EDITORS.flatMap((editor) =>
  'claims' in editor ? [{ id: editor.id, claims: editor.claims }] : [],
);

export const EDITOR_IDS: readonly EditorId[] = EDITORS.map((editor) => editor.id);

export function editorTitle(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.title ?? id;
}

/**
 * Where `view.open` puts an editor: in the pane you are in, in a new one beside it, or
 * `elsewhere` — the biggest pane that is *not* the one asking, splitting only when there is no
 * other. That last one is what a sidebar wants: opening into itself would replace the sidebar.
 */
export type OpenWhere = 'here' | 'left' | 'right' | 'above' | 'below' | 'elsewhere';

export const OPEN_WHERE = ['here', 'left', 'right', 'above', 'below', 'elsewhere'] as const;

/**
 * Where this build's registry and this list disagree. Both directions matter and only one of
 * them is visible without asking: an id in `EDITORS` that nothing registered fails at the moment
 * someone picks it out of the palette, while a registered editor missing from here never reaches
 * `view.*` at all — yet still shows up in path.ux's own area-switcher menu, which enumerates the
 * area classes and knows nothing about this file.
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
