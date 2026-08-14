/**
 * Every editor the shell can show, and the one place their names are written down.
 *
 * It is here rather than in the renderer because `view.*` runs in main like every other command
 * and needs the list to declare its props — the catalog then offers the real names to the
 * palette, to CDP and to the agent. The renderer registers each editor class under the matching
 * area name, and the shell checks the two agree at boot.
 *
 * The header bar is deliberately absent: it is chrome, not somewhere the author navigates to.
 */
export const EDITORS = [
  { id: 'branches', title: 'Branches', what: 'the story graph as index cards' },
  { id: 'script', title: 'Script', what: "one scene's lines" },
  { id: 'convo', title: 'Convo', what: 'the vnauthor conversation' },
  { id: 'timeline', title: 'Coverage', what: 'a scene against the shots that illustrate it' },
  { id: 'tasklist', title: 'Tasks', what: 'the pipeline task list' },
  { id: 'taskgraph', title: 'Task Graph', what: 'the pipeline task graph' },
  { id: 'inspector', title: 'Inspector', what: 'what is selected, in detail' },
  { id: 'play', title: 'Play', what: 'the runner' },
  { id: 'wiki', title: 'Wiki', what: 'one markdown document' },
  { id: 'documents', title: 'Documents', what: "the project's documents and what links to them" },
] as const;

/** An editor's area name — the value `view.open`, `view.focus` and a stored layout all use. */
export type EditorId = (typeof EDITORS)[number]['id'];

export const EDITOR_IDS: readonly EditorId[] = EDITORS.map((editor) => editor.id);

export function editorTitle(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.title ?? id;
}

/** Where `view.open` puts an editor: in the pane you are in, or in a new one beside it. */
export type OpenWhere = 'here' | 'left' | 'right' | 'above' | 'below';

export const OPEN_WHERE = ['here', 'left', 'right', 'above', 'below'] as const;

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
