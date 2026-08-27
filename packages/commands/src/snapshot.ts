/**
 * `@vn/commands/snapshot` — the content-addressed store and the undo journal built over it.
 *
 * This is a second entry rather than part of the barrel because both halves read and write files,
 * while the renderer imports the package for the command record and the DSL. One barrel over both
 * would put `node:fs` in a browser bundle. Only a host that snapshots a workspace names this
 * entry; `UndoPoint`, which a record carries and a renderer reads, stays in the main entry.
 */

export {
  ContentStore,
  EMPTY_HASH,
  MEDIA_EXTS,
  type EntryKind,
  type StoreStats,
  type TreeEntry,
} from './content.js';
export { UndoJournal, type UndoJournalOptions } from './undo.js';
