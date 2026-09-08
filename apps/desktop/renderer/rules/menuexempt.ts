/**
 * The mutating commands a menu runs on the click that neither undo nor confirm, each with the
 * reason it is allowed to. The rule in `src/main/tests/uxmodel.test.ts` reads this list: a menu
 * entry that runs a mutating command must be undoable, confirm first, open a form, or be here,
 * and an entry here that no menu runs on the click fails the test as dead.
 */
export interface MenuExempt {
  id: string;
  why: string;
}

export const MENU_EXEMPT: readonly MenuExempt[] = [
  {
    id : 'asset.accept',
    why: 'Reversed by asset.unapprove, which confirms; accepting a picture spends nothing.',
  },
  {
    id : 'story.screenplay',
    why: 'Writes the screenplay file the author asked for by name; nothing else changes.',
  },
  {
    id : 'pipeline.run',
    why: 'The app menu asks command:check first and refuses with its sentence; the run opens the task list, where it can be stopped.',
  },
  {
    id : 'workspace.open',
    why: 'Workspace-level: it changes which project is open, and nothing in the project.',
  },
  {
    id : 'workspace.pick',
    why: 'Workspace-level: the OS chooser it opens is its own confirmation, and nothing in the project changes.',
  },
  {
    id : 'workspace.reindex',
    why: 'Workspace-level: it rebuilds a derived index, and nothing the author wrote changes.',
  },
];
