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
] as const;

/** An editor's area name — the value `view.open`, `view.focus` and a stored layout all use. */
export type EditorId = (typeof EDITORS)[number]['id'];

export const EDITOR_IDS: readonly EditorId[] = EDITORS.map((editor) => editor.id);

export function editorTitle(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.title ?? id;
}

/** Where `view.open` puts an editor: in the pane you are in, or in a new one beside it. */
export type OpenWhere = 'here' | 'right' | 'below';
