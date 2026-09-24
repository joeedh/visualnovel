# Wiki and file tree editing

Status: shipped — all five stages. Reviewed once by a fresh-context agent; its nineteen
findings and how each was answered are in [Review](#review).

This plan covers the six items in `todos.md` under "Wiki Subtree / File Tree Commands".
All of them land in the `documents` editor, in both of its modes: the logical document
tree (its Wiki branch: `branch:wiki`, `wikidir:<rel>`, `wiki:<rel>`) and file mode
(`workspace:filetree`: `dir`, `file`).

1. A "new folder" entry on folders in the wiki subtree and in file mode.
2. A "new file" entry on the same folders.
3. Multiselect in the file tree.
4. Copy, cut and paste entries in the file tree and the wiki subtree.
5. Moving files and folders in both, undoably.
6. Renaming wiki files.

It reverses part of [`document-tree.md`](../../reference/document-tree.md), which lists
"Moving and deleting through the tree" as deliberately absent. Moving and renaming arrive;
deleting stays absent. Today `wiki` and `file` rows have one menu entry, Show history, and
`dir` rows have none. The table in `document-tree.md` still says all three have no menu;
stage 1 corrects that line.

<!-- toc -->

<!-- tocstop -->

## What exists today

Facts the decisions below rest on, with where each one lives.

- **No command moves, copies or renames a file.** `doc.rename`
  (`apps/desktop/src/main/commands/doc.ts`, `src/main/doctree/rename.ts`) rewrites the
  name a document is known by (a sheet's `name:`, else front-matter `title:`, else the
  first H1) and never moves the file.
- **`doc.create` always files a note at `wiki/<slug>.md`.** The `wikidir` menu's "New wiki
  page…" therefore creates the page at the wiki root, not in the folder that was
  right-clicked (`newDoc` in `src/main/session/docs.ts`).
- **Neither tree can show an empty folder.** `walkFiles` (`src/main/session/core.ts`)
  returns files only, and `fileTree` derives every `dir` node from a file path. The Wiki
  branch is built from `Bible.files()`, which lists `.md` files only (`listMarkdownTree`
  in `@vn/bible`'s indexer), so a folder holding no markdown does not appear there either.
- **Undo snapshots skip empty directories, media and a few subtrees.**
  `ContentStore.capture` (`packages/commands/src/content.ts`) records no entry for an
  empty directory. It skips every file whose extension is in `MEDIA_EXTS` (png, jpg, pdf,
  zip, fonts, audio, video and others), `.git` and `node_modules` wherever they appear,
  symlinks, and `UNDO_EXCLUDES` (`vngen/build`, `vngen/state`, `assets/objects`, `keys`,
  `.vnstudio/session.json`, `.gitmodules`).
- **A capture trusts `(mtime, size)` per absolute path.** `ContentStore.seen` records what
  it last read at each path and reuses the hash when a later stat matches.
- **A restore removes a directory it emptied.** `restoreDir` → `removeDir` deletes the
  files a tree recorded and then `rmdir`s the directory, which fails silently when a
  skipped file (an image) is still inside.
- **A bracketed command that changed nothing is walked past by undo.** `undoCandidate`
  skips a record whose `undo.changed` is false. A mutating command with no undo point
  blocks undo instead (`undoState().blocked`). Any mutating command clears the redo stack.
- **Entity ids come from paths.** `discoverEntities` (`packages/store/src/entities.ts`)
  finds `characters/<id>/character.md` (id is the directory), top-level
  `locations/<id>.md` (id is the stem), and `wiki/**/<id>.md` carrying a `type:` tag (id
  is the stem). A conventional sheet whose tag disagrees with its directory is dropped
  with a diagnostic (`tagConflict`). When two files claim one id, one wins by a fixed rule
  and the other is reported (`dedupe`).
- **Links between documents are relative markdown links.** `[Aiko](../cast/aiko.md)` and
  `![](../../assets/objects/<hash>.png)`, written by `linkHref` and resolved by
  `resolvePath` (`renderer/pathux/doctree/doclinks.ts`, `docpath.ts`). Nothing rewrites
  them today.
- **The tree has one selection, and it is app-wide.** A click publishes `ui.docPath` (and
  the other `ui.*` fields). `dir` and `wikidir` rows publish nothing; a click on one
  toggles it. No tree in the app has multiselect, and path.ux has no tree widget with
  multiselect. The one precedent for a multi-selection is the Script editor's marked lines
  (`lidAction` in `renderer/rules/script.ts`, `pane.view(what=mark)`, and
  `story.deleteLines` on Delete).
- **Menu entries are commands or effects.** `MenuEntry`
  (`renderer/pathux/chrome/contextmenu.ts`) holds an id and props. `needsCheck` sends a
  command entry to `stack.check` before the menu opens, whether or not the command is
  mutating; a command with no `check` resolves `undeclared` and draws enabled. `form`
  entries open the command's dialog unchecked, `supplies` entries run a pane handler
  unchecked, and `refused` carries a refusal sentence the pane computed itself, drawn
  greyed. Effect entries are never checked.
- **The `affects` vocabulary is closed** (`src/shared/affects.ts`): twelve directory roots
  and five root files. It is an upper bound that only tests read; nothing refuses a write
  outside it at run time.
- **Drafts are keyed by path.** `docbuffer.ts` and `docsession.ts` hold unsaved text and
  rich sessions per workspace-relative path. A `DocSession`'s `path` is `readonly` and its
  provider is built for that path. `draftPaths()` lists every path with unsaved edits and
  is what Save All reads.
- **Every `docs` UI push saves all drafts.** `bridge.ts` handles `effect.type === 'docs'`
  by calling `saveAllDrafts()` without reading `action`, because `saveAll` is the only
  action today.
- **A project can span repositories.** `wiki/` (or `assets/`) can be a nested repository
  or a submodule, possibly shared by several projects; a submodule that is not checked out
  is an empty directory reported `missing: true` by `Workspace.repos()`
  ([`repos-and-commits.md`](../../reference/repos-and-commits.md#submodules)).
  `RepoResolver.rootOf` (`@vn/git`) answers which repository a path is in.
- **File history does not follow renames.** `@vn/git` runs `git log` without `--follow`.

## Decisions

### D1. The command set

Four new commands, and one new prop on `doc.create`. All ids are `doc.*`, since the
namespace already means "authored documents" and these act on the same files.

| id                     | mutating | undoable | affects      | props                                            | what it does                                          |
| ---------------------- | -------- | -------- | ------------ | ------------------------------------------------ | ----------------------------------------------------- |
| `doc.mkdir`            | yes      | yes      | `FILE_ROOTS` | `parent`, `name`                                 | Creates one empty folder                              |
| `doc.newFile`          | yes      | yes      | `FILE_ROOTS` | `parent`, `name`, `open` (default true)          | Creates one empty file                                |
| `doc.move`             | yes      | yes      | `FILE_ROOTS` | `paths: string[]`, `into`, `name` (default `''`) | Moves files and folders into a folder, or renames one |
| `doc.copy`             | yes      | yes      | `FILE_ROOTS` | `paths: string[]`, `into`                        | Copies files and folders into a folder                |
| `doc.create` (changed) | yes      | yes      | unchanged    | adds `dir` (default `''`)                        | A `note` is filed in `dir` when given                 |

- `FILE_ROOTS` is a new constant in `src/shared/fileops.ts`:
  `['wiki', 'characters', 'locations', 'archive']`. See D2.
- **Renaming is a move.** A rename is a move into the folder the path is already in, under
  a new name. `name` is valid only with exactly one path; it names the moved item at its
  destination. With `name` empty, a move into the folder the path is already in is refused
  as a no-op; with `name` set, it is a rename.
- `doc.move` and the existing `doc.rename` change different things. `doc.rename` changes
  the name a reader sees and leaves the file where it is; `doc.move` with `name` changes
  the file name and leaves the name a reader sees alone (unless that name was the stem).
  D5 explains why both stay.
- `doc.create`'s new `dir` prop applies to `kind: 'note'` only. A non-empty `dir` for any
  other kind is refused ("A character sheet is always created in characters/; move it
  afterwards to file it elsewhere."), because the other kinds have a conventional home
  that discovery depends on. `dir` must be `wiki` or a folder under it.
- The clipboard is renderer state (D9), so it needs no command.

Descriptions (the registry text, which is also every entry's tooltip):

- `doc.mkdir`: "Create an empty folder inside another folder. Git does not record empty
  folders, so the folder exists on this disk only until a file is put in it."
- `doc.newFile`: "Create an empty file with the given name inside a folder, and open it.
  Refused for a name already taken there, and for a file the model would read as a
  character or location sheet."
- `doc.move`: "Move files and folders into another folder, or rename one file or folder
  with `name`. Relative links in other documents that pointed at them are rewritten to the
  new place. Refused when it would change which characters and locations the project has,
  or cross into another git repository."
- `doc.copy`: "Copy files and folders into a folder. A name already taken there gets
  `-copy` added. Refused for a character or location sheet, since the copy would be a
  second one."

### D2. Where file operations are allowed

- **The four roots.** Every source, every destination and every `parent` must be inside
  `wiki/`, `characters/`, `locations/` or `archive/`. A source or a created path must not
  be the root folder itself (moving or renaming `wiki/` is refused), but a `parent` or a
  destination folder may be: New folder… on `branch:wiki` has `wiki` as its parent.
  `rootProblem` takes a role (`'folder'` or `'item'`) for this; stage 1 corrected the
  earlier wording, which refused a root as a parent too.
- **Why these four.** They are the author's own folders, and the only ones where the app
  reads nothing by a fixed path except the entity sheets D6 protects.
    - `scenes/` has one validated writer, `story.*`.
    - `vngen/` is generated output and pipeline state; `vngen/work/graphs` belongs to
      `gengraph.*` and `vngen/work/shots/<sceneId>.json` is found by scene id.
    - `assets/` is the content-addressed base store and its manifest.
    - `.aiagent/skills/<id>` is found by directory name and has its own pane and commands.
    - `.vnstudio/`, `.github/`, `keys/` and the root files (`project.yaml` and the rest)
      are app or repository configuration.
- **The declaration is enforced.** The four mutating file commands declare
  `affects: FILE_ROOTS` and their checks refuse any path outside it. They are the first
  commands whose `check` refuses exactly what their `affects` leaves out. That keeps the
  declaration true without changing the stack, where `affects` stays an unenforced upper
  bound for every other command.
- **New top-level folders are refused.** A folder at the project root would be outside the
  closed vocabulary and outside `FILE_ROOTS` (decided, see
  [Decided for now](#decided-for-now), item 3).
- The refusal sentence names the four roots: "Files can be created, moved and renamed only
  under wiki/, characters/, locations/ and archive/. scenes/ is written by the story
  commands."
- **Repository boundaries.** A move or copy whose source and destination folder are in
  different git repositories is refused, and so is every file command whose destination is
  inside a repository reported `missing`. See D3.

### D3. Refusals

Every mutating file command's `check` and `run` call one planner, so a menu shows the
refusal the run would give. Path-only rules are pure and live in `src/shared/fileops.ts`,
where the renderer also uses `rootProblem` and `fileNameProblem` to fill `refused` on form
and rename entries. Rules that need the disk live in the new `FilesPart`
(`src/main/session/files.ts`).

Path rules (pure):

- A name is refused when it is empty, `.` or `..`, contains `/`, `\`, `<`, `>`, `:`, `"`,
  `|`, `?`, `*` or a control character, ends in a dot or a space, or is a Windows reserved
  name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an
  extension). The rule is Windows' because a collaborator may be on Windows even when the
  author is not.
- A path outside `FILE_ROOTS`, or one of the roots itself (D2).
- A path under a user or builtin skill tier (`skillTierPath`), for the same reason
  `doc.write` refuses it.
- Moving a folder into itself or into a folder under it.
- Moving a path into the folder it is already in with `name` empty ("wiki/a.md is already
  in wiki.").
- `name` set with more than one path.
- A rename to the same name, and a rename whose new name differs from the old one only by
  letter case. On Windows and macOS the restore that undo runs would write `a.md` and then
  delete `A.md`, which is the same file, so undoing such a rename would delete it.
- Two sources with the same name moved into one folder.
- `paths` that list a folder and something inside it are not refused: the inner path is
  dropped, since moving the folder moves it.

Disk rules (`FilesPart`):

- A source that does not exist ("no such file: wiki/a.md"), and an `into` or `parent` that
  is not a directory. This is also what refuses a Paste after the cut path was moved some
  other way.
- A name already taken at the destination. The comparison ignores case on Windows and
  macOS. `doc.move` refuses; `doc.copy` picks a free name instead (D9).
- **A different repository.** `RepoResolver.rootOf` is asked for each source and for
  `into`; any difference is refused. Two paths outside any repository (`null`) count as
  the same. Sentence: "wiki/a.md and archive/ are in different git repositories (wiki/ is
  a repository of its own). Moving or copying between repositories is not supported in the
  app, because the file's history would stay in one and other projects sharing wiki/ would
  see it vanish." The check runs for `doc.copy` too, so a copy into a shared wiki cannot
  land in another project's history unnoticed.
- **A repository that is not checked out.** A destination inside a directory that
  `Workspace.repos()` reports `missing` is refused for all four commands. `rootOf` cannot
  catch this case, since an empty submodule directory resolves to the project's own
  repository. Sentence: "wiki/ is a submodule that is not checked out, so nothing written
  there would be in any history. Run `git submodule update --init` first."
- **Anything undo cannot hold.** A source that is, or contains, a media file
  (`MEDIA_EXTS`), a symlink or other non-regular file, a `.git` entry (a nested repository
  or submodule), a `node_modules` directory, or a path under `UNDO_EXCLUDES`. Undo's
  snapshot does not record any of these, so an undo would leave them at the destination
  and, for a folder, leave the folder behind with them. The sentence names the first
  offending path: "wiki/places/cafe.png is an image. Undo does not keep images, so the app
  does not move or copy them; move it outside the app."
- `doc.newFile` with a media extension, for the same reason, and because an empty image
  file is not a picture.
- **An entity whose identity would change** (D6).
- Guarded directories and `keys/` are already outside `FILE_ROOTS`; `doc.newFile`
  additionally writes through `writeDocFile`, so it inherits that function's refusals.

**How much a check reads.** The full check, including the media, `.git` and symlink scan
and the identity rule, runs before every menu that shows a Paste entry, because a refusal
has to be visible before the author acts. `command-system.md` ("From a right-click") says
checks are awaited before the menu opens, that "each check is a read-only preview over
state main already holds", and that a check slow enough to notice is fixed rather than
skipped. It does not forbid disk reads: `doc.write`'s and `doc.rename`'s checks already
read the file they name. So the file checks are bounded the same way: they read only the
paths named and the subtrees under them (a `readdir` walk for names and file types), plus
the front-matter of the `.md` files among them that are under `wiki/`, which is where a
tag decides identity. They read nothing else, and they cache nothing. The discovery result
D6 compares against is the session's current load, which main already holds.

### D4. Undo

All four mutating file commands are `undoable: true` and are bracketed by the stack's
ordinary pre and post captures. Nothing changes in `@vn/commands`.

- **A move is representable.** The pre tree has the files at the old paths and the post
  tree has the same blobs at the new ones. Undo writes the old paths back from the blobs
  and removes the new ones, `rmdir`ing any directory that empties. Redo does the reverse.
  Blobs are shared by hash, so a move or a copy adds trees to the store and no bytes.
- **Links rewritten by the move are in the same bracket** (D7), so one undo restores the
  files and the link text together.
- **D3 is what makes every accepted move representable.** Everything the snapshot skips is
  refused, so a restore never has a file to leave behind.
- **Case-only renames are refused** (D3) because the restore would delete the file on a
  case-insensitive filesystem.
- **A moved file's mtime is set to now.** After each rename, the run sets every
  destination file's mtime to the current time with `utimes`. `ContentStore.seen` is keyed
  by absolute path and trusts a matching `(mtime, size)`; a file renamed onto a path where
  a same-size file with the same mtime was recorded earlier would otherwise be captured
  with the old file's hash. A fresh mtime cannot match an older record. This needs no
  change to `@vn/commands`.
- **`doc.mkdir` produces no undo point.** An empty folder has no entry in a tree, so its
  pre and post trees are equal, `undo.changed` is false, and undo walks past it to the
  command before. The folder stays. Declaring the command non-undoable instead would make
  it block undo of everything before it (`undoState().blocked`), which is worse.
- **`doc.mkdir` clears the redo stack,** as every mutating command does. Making a folder
  after an undo therefore loses the redo, which the docs state.
- **Undoing the first thing put into a new folder removes the folder.** The folder is not
  in the pre tree, so the restore's `removeDir` deletes it once it is empty. Redo brings
  it back with its contents. This follows from the snapshot having no empty trees, which
  is deliberate (`content.ts`), and the plan does not change it. The docs say so.
- **A partial failure is rolled back by the command.** A run moves sources one at a time
  with `fs.rename` (a directory moves whole), then rewrites links. If a step fails (for
  example `EPERM` on Windows because another program holds a file open, or a linking file
  that changed during the run), the run restores rewritten files from the bytes it read,
  renames what it moved back in reverse order, and throws with the original error. A
  failed record carries no undo point, so the command must leave the tree as it found it.
  Copies are removed the same way. If the rollback itself fails, the error names the paths
  left at the destination.
- **Undo and redo do not move open editors.** D13 follows a move in open editors; an undo
  or redo reports only `written`. A clean Wiki pane showing the moved-to path re-reads it
  and reports it gone, as it does today when undo removes a page made by `doc.create`.
  Recorded as a known limitation.

### D5. What "renaming wiki files" means

- `doc.rename` already renames a page's title, and it is correct for what it does. What is
  missing is changing the file name, which `doc.rename` does not do by design because a
  file name can be an id.
- For a plain note (no `type:` tag) the file name is not an id. Only links point at it,
  and D7 rewrites those. So renaming a note's file is safe, and `doc.move` with `name`
  does it.
- For an entity sheet the file name is the id (D6), and the rename is refused:
  "wiki/cast/aiko.md is the sheet for character aiko, and its file name is the id shots
  and cast lists use. Renaming the file would make a different character. Double-click it
  in the tree to change the name it is shown under."
- Folders are renamed the same way. Renaming `wiki/cast` to `wiki/people` keeps every
  sheet's stem, so D6 accepts it.
- `file` and `dir` rows in file mode get the same command, under the same rules.
- **Both renames stay, on different gestures.** A double-click on a `wiki` row keeps
  retitling the page, since the row's label is the title. "Rename file…" in its menu, and
  F2, rename the file. On `file`, `dir` and `wikidir` rows the label is the file or folder
  name, so a double-click on a `file` row, "Rename…" and F2 all rename the file.
  Conflating the two on a `wiki` row would make a double-click on an entity sheet refuse
  whenever it tried to move the file.
- Changing the extension is allowed. When a `.md` file stops being `.md`, the check's note
  says so: "a.txt is not markdown, so the Wiki branch will stop listing it."
- **History does not follow.** Show history on a moved or renamed file starts at the move,
  because `@vn/git` has no `--follow`. Adding it is out of scope.

### D6. Entities keep their identity

- **The rule compares against what discovery assigns today, not a re-derivation.**
    - `@vn/store` gains `discoverCandidates(paths, diagnostics)`, which returns every
      candidate sheet (kind, id, file) before `dedupe`, losers of a duplicate included.
      `discoverEntities` is rebuilt on it, so the two cannot drift.
    - `@vn/store` also gains the pure `entityIdentity(path, data)`: the identity a file at
      `path` with front-matter `data` would be given as a candidate, or `undefined`. It
      mirrors discovery exactly: `characters/<id>/character.md`, `locations/<id>.md` at
      the top level of `locations/` only (as `fromLocationsDir` reads), and a tagged `.md`
      under `wiki/`. A conventional sheet whose tag conflicts with its directory gets
      `undefined`, as `tagConflict` drops it.
- **For a move,** `FilesPart` builds a path → identity map from `discoverCandidates` over
  the current project. For every moved `.md` file (including every file inside a moved
  folder), `entityIdentity(newPath, data)` must equal the map's entry for the old path, or
  both must be `undefined`.
- **For `doc.copy` and `doc.newFile`,** every file created must get `undefined`: a copy of
  a sheet would be a second entity under a derived id, and a new empty `locations/x.md`
  would be a new location with no fields.
- **Duplicates.** Because the map holds candidates rather than winners, a file that is
  currently the losing copy of a duplicate id keeps that identity through a move, and the
  move is accepted even when it changes which file wins. A duplicate id is already a
  reported diagnostic, and the move does not create one.
- **Agreement test.** A fixture includes a nested `locations/sub/x.md` (not an entity), a
  conventional sheet with a conflicting tag, and two files claiming one id. For every
  `.md` file in it, `entityIdentity` equals what `discoverCandidates` assigns.
- Consequences, each stated in the docs:
    - A tagged sheet can be moved anywhere under `wiki/` as long as its file name stays
      the same.
    - Moving `characters/aiko/` or renaming `locations/cafe.md` is refused.
    - Moving `locations/cafe.md` into `wiki/places/` is accepted only when the sheet
      carries `type: location`, because only then is it still the same location.
    - Moving a plain note into `locations/` is refused, since it would become a location.
- The refusal names the entity: "Moving characters/aiko would change character aiko's id,
  which shots and cast lists use."

### D7. Links follow a moved file

- **Decision: rewrite links.** Every link to a moved page would otherwise break with no
  sign until someone follows it. The rewrite is mechanical, since links are relative
  paths, and it stays inside the undo bracket.
- New pure module `src/main/doctree/relink.ts`. Given a document's path, its text and a
  move map (`{ from, to }[]`, where a folder entry covers everything under it), it returns
  the rewritten text and a count.
    - It rewrites inline links and images (`[t](href)`, `![a](href)`, with an optional
      `"title"`), angle-bracket hrefs (`[t](<a b.md>)`), and reference definitions
      (`[id]: href`).
    - It leaves alone fenced code blocks, inline code, URLs with a scheme, hrefs starting
      with `/` or `#`, and hrefs that do not resolve inside the workspace.
    - A `#fragment` and a `?query` are kept.
    - A `%20`-encoded href is decoded to resolve it and re-encoded to write it.
- **Inbound links.** Every `.md` file under `wiki/`, `characters/` and `locations/` that
  is not itself moved is scanned. A link that resolves to a moved path is rewritten
  relative to the linking document.
- **Outbound links.** Every moved `.md` file has each relative link re-resolved from its
  old location, mapped through the move map, and rewritten relative to its new location.
  That covers picture links into `assets/objects/` too, which `pictureAsset` reads.
- **`archive/` is never rewritten.** `upload.files` copies the author's own documents
  there unchanged, and they stay verbatim. Files under `archive/` are not scanned for
  inbound links, and a moved file whose old or new path is under `archive/` keeps its text
  unchanged.
- **`scenes/` is not scanned.** Scene files have one writer (`story.*`), and a scene chunk
  is Fountain rather than markdown with links.
- **Bytes, not documents.** The rewrite reads a file, replaces the hrefs, and writes it
  with `writeFileAtomic` after confirming the file still hashes to what was read. It does
  not go through `writeDocFile`: there is no front-matter parse and no size refusal, so a
  note with broken front-matter or an oversized file cannot block a move. A file that
  changed between the read and the write fails the run, which rolls back (D4). The written
  bytes are handed to `fileCache.note`, as a save does.
- `writeDocFile`'s doc comment ("the only whole-document write path") is corrected in
  stage 2 to name the relink write beside it.
- **Only the run rewrites.** The check does not scan for links, because a scan reads every
  document and the check is bounded to the named paths (D3). The run's message reports the
  count: "Moved wiki/a.md to wiki/lore/a.md; updated links in 2 documents."
- `docpath.ts` (`relativePath`, `resolvePath`) moves from `renderer/pathux/doctree/` to
  `src/shared/`, so main and the renderer use one implementation. Its test moves with it.

### D8. New file and new folder

- **Naming is a form, not an inline placeholder row.** Every existing "New …" entry in the
  tree is a `form: true` entry that opens the command's dialog with the known props filled
  in, and the dialog shows the check's verdict as the author types. An inline placeholder
  row would need a new kind of transient node in a tree that main builds.
- **In the Wiki branch, "new file" means a new page.** The Wiki branch lists only
  markdown, so a non-markdown file created there would not appear in it.
    - "New wiki page…" on a `wikidir` row runs `doc.create` with
      `{ kind: 'note', dir: <folder> }`, so the page lands in that folder. This fixes the
      current behaviour, where it lands at the wiki root.
    - On `branch:wiki` it runs `doc.create` with `{ kind: 'note' }`, unchanged.
    - The page gets a `# Name` heading and a slugged file name, as today.
- **In file mode, "New file…" runs `doc.newFile`.** The name is used as typed, extension
  included; there is no template and the file is empty. With `open: true` it opens in the
  Wiki editor through `view.open`, as `doc.create` does.
- **"New folder…" runs `doc.mkdir`** in both modes: on `branch:wiki`, `wikidir` and `dir`
  rows.
- After either command, the new path is revealed in the window that ran it (D13).

### D9. The clipboard

- **The renderer holds it, per window.** A module-level
  `{ paths: string[]; mode: 'copy' | 'cut' }` in a new
  `renderer/pathux/doctree/clipboard.ts`, shared by the documents panes of one window and
  not persisted. Pasting in a different window is not supported.
- **Why not main.** Paste becomes an ordinary `doc.move` (after Cut) or `doc.copy` (after
  Copy) with every prop filled in, checked like any other entry, so the command record
  names what was pasted and where. A main-side clipboard would need a set command, a read
  command, a broadcast and a paste command whose invocation does not name its sources.
- **Copy and Cut are an effect, `pane.view(what=clip)`,** with `on: 'copy'` or
  `on: 'cut'`. `pane.view` is described as changing "what the pane shows and nothing the
  project holds", and the clipboard is exactly that: it changes which rows draw dimmed and
  what Paste says, and writes nothing. It is how the pane's marks are already expressed
  (`pane.view(what=mark)`). The effect registry does not change: `clip` is a new value in
  the `VIEWS` list in `src/shared/effects.ts`, and the count of effects stays twelve, so
  CLAUDE.md does not change.
- **Cut does not change anything on disk;** the move happens at Paste.
- **Paste target.** A folder row (`wikidir`, `dir`) or `branch:wiki` pastes into that
  folder (`wiki` for the branch). A file row (`wiki`, `file`) pastes into the folder the
  file is in.
- **After a Cut is pasted, the clipboard is cleared.** After a Copy is pasted, it is kept,
  so the same items can be pasted again.
- **Stale entries are caught by the command.** A path that was cut and then moved some
  other way (the palette, an undo, another window) is refused at Paste by `doc.move`'s own
  check ("no such file: wiki/a.md"). The clipboard is not remapped.
- **Copy's name collisions** add `-copy` before the extension, then `-copy-2`, `-copy-3`:
  `a.md` → `a-copy.md`, folder `lore` → `lore-copy`. No spaces or parentheses, because a
  relative link written by `linkHref` to `a (copy).md` does not parse as a markdown link.
  Copying into the source's own folder is therefore the way to duplicate a page.
- **Pasting across modes works without special handling.** Both trees name files by
  workspace-relative path, so a page cut in the Wiki branch can be pasted into a `dir` row
  in file mode and the reverse, in the same pane or another pane of the same window.
- **The OS clipboard is not used.** Pasting files copied in Explorer or Finder would be an
  import from outside the workspace, which is `upload.*`'s job and brings in media undo
  cannot hold. Writing a file list in the OS formats is platform-specific (CF_HDROP,
  NSFilenamesPboardType) for no gain inside the app. "Copy path" (D11) puts a path on the
  OS clipboard as text, through the existing `app.copy`.

### D10. Multiselect

- **Where:** both modes. The todo names the file tree, but Copy, Cut and moving apply to
  the Wiki branch too, both modes are one pane with one flattener, and moving five pages
  one at a time is the problem multiselect exists to fix.
- **Which rows can be marked:** `wiki`, `wikidir`, `file` and `dir` rows whose path is
  inside `FILE_ROOTS` (`rootProblem` answers nothing). Other rows cannot be marked, so
  every marked row is one the file commands accept.
- **The term is "marked",** as in the Script editor. `ui.docPath` stays the one app-wide
  selection; the marked set belongs to the pane.
- **State:** two pane fields, `marks: string[]` (node ids, in click order) and
  `anchor: string` (the last row clicked without Shift). They are not declared to
  nstructjs and not persisted, for the reason the search box's query is not: paths can be
  gone by the next session, and a restored set of marks the author cannot see would be
  acted on by the next Cut.
- **Clicks** (Ctrl is Cmd on macOS):
    - Plain click on a markable row: `marks = [row]`, `anchor = row`, then what the click
      does today (a file or page publishes `ui.docPath` and opens its editor; a folder
      toggles).
    - Ctrl-click on a markable row: toggle the row in `marks`, `anchor = row`. It does not
      publish, open or toggle.
    - Shift-click on a markable row: `marks` becomes every markable row drawn between
      `anchor` and this row, inclusive, in draw order. It does not publish, open or
      toggle. With no anchor drawn, it acts as a plain click.
    - Any click on a row that cannot be marked clears `marks` and does what it does today.
    - **A click with Ctrl, Cmd or Shift held neither counts toward a double-click nor
      fires `onSecondClick`.** Without this, two quick Ctrl-clicks on a row would open the
      rename box. `countClick` is not called for such a click, and the latch is reset.
    - Escape while the pane has focus clears `marks`.
- **Drawing:** a marked row draws with a new `marked` class in `styles/treeview.css`,
  distinct from `sel`. `sel` keeps meaning "this row is `ui.docPath`" (or the other
  published fields), so the row whose editor is open stays identifiable inside a larger
  marked set. A row whose path is on a Cut clipboard draws dimmed (a `cut` class).
- **Keeping marks valid:** switching mode clears them. A refetch drops ids no longer in
  the tree. Changing the filter query drops marks on rows the filter hides, so an action
  never includes a row the author cannot see. A move maps them (D13).
- **Right-click:**
    - On a row that is marked while two or more rows are marked: the menu acts on every
      marked row. Its title is "3 items".
    - On any other row: `marks = [row]` when the row is markable, else `marks = []`; then
      today's behaviour (publish the selection without routing) and that row's menu.
- **Recording:** a markable row's offer (`rowAction` in `rules/documents.ts`) gains
  `pane.view(what=mark)` in `then`, and its tooltip gains "Ctrl-click or Shift-click to
  select several", as the Script editor's gutter number records its mark. Escape is a
  `documents`-scope row in the shortcuts table running `pane.view(what=mark)`.
- **Pure rules** live in a new `renderer/pathux/doctree/marks.ts`:
  `markClick(state, row, rows, mods)`, `menuTargets(state, row)`,
  `pruneMarks(state, rows)` and `remapMarks(state, moves)`. The pane applies their
  answers.
- `treeview.ts`'s `onClick` gains the pointer's modifiers (`{ ctrl, shift }`). The Skills
  pane, the other `renderTree` caller, ignores them.

### D11. Menus

Single-row menus after this plan (entries in draw order; `—` is a separator). Existing
entries not listed are unchanged.

| node kind     | entries                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `branch:wiki` | New wiki page… · New character sheet… · New location sheet… · — · New folder… · Paste                                            |
| `wikidir`     | New wiki page… · New character sheet… · New location sheet… · — · New folder… · — · Cut · Copy · Paste · — · Rename… · Copy path |
| `wiki`        | Cut · Copy · Paste · — · Rename file… · Copy path · Show history                                                                 |
| `dir`         | New file… · New folder… · — · Cut · Copy · Paste · — · Rename… · Copy path                                                       |
| `file`        | Cut · Copy · Paste · — · Rename… · Copy path · Show history                                                                      |

With two or more rows marked and the menu raised on one of them: "Cut 3 items" · "Copy 3
items", then, when the row under the pointer is a folder, "Paste into lore".

How each entry is built:

- **Cut / Copy:** `pane.view(what=clip)` with `on: 'cut'` or `on: 'copy'`; the handler
  writes the clipboard (D9). On a row outside `FILE_ROOTS` the entry carries `refused`
  from `rootProblem`, since an effect entry is never checked and would otherwise draw
  enabled and fail only at Paste.
- **Paste:** `doc.move` (Cut clipboard) or `doc.copy` (Copy clipboard) with
  `{ paths, into }`, checked, so a refusal draws greyed with its sentence. With an empty
  clipboard it carries `refused: 'Nothing has been copied or cut yet.'` rather than being
  hidden, as the menu rules require. For a Cut clipboard, when any path on it is in
  `draftPaths()`, it carries `refused: 'Save wiki/a.md first — it has unsaved edits.'`
  (D13). Its label is "Paste", or "Paste 3 items". When the check accepts, its note is the
  tooltip: "Moves wiki/a.md and wiki/b.md into wiki/lore."
- **New wiki page… / New folder… / New file…:** `form: true` with the parent filled in. A
  form entry is not checked, so when `rootProblem(parent)` refuses the parent, the entry
  carries that sentence as `refused`. Example: New folder… on `dir:scenes`.
- **Rename… / Rename file…:** `doc.move` with `{ paths: [path], into: <its folder> }`,
  `supplies: ['name']` and `on: 'rename'`. The pane's handler opens the inline box
  described in stage 5. It carries `refused` from `rootProblem(path)` outside
  `FILE_ROOTS`, and the unsaved-edits sentence when the path, or a path under a folder
  being renamed, is in `draftPaths()`.
- **Copy path:** `app.copy` with `{ text: path, what: 'path' }`, the same pattern as the
  other rows' "Copy … id".
- `menuFor(node, order)` becomes `menuFor(node, order, ctx)`, where `ctx` carries the
  clipboard, the marked rows and the dirty paths.
- **The derived model.** The `doctree` row in `rules/menus.ts` gains situations in a new
  `rules/situations/doctreemenu.ts`: no clipboard, a Cut clipboard, a Copy clipboard, and
  three marked rows. `doc.mkdir` and `doc.newFile` are drawn in the first, `doc.move` in
  the second (Paste and Rename), and `doc.copy` in the third, which is how
  `uxmodel.test.ts`'s check that every command is drawn or listed is met. A command that
  no situation draws gets a `paletteonly.ts` entry with a reason; in this plan that is
  only `doc.move` and `doc.copy` during stages 2 and 3, before any menu draws them.

### D12. Keyboard

New `documents`-scope rows in `renderer/rules/shortcuts.ts`.

| keys   | label       | runs                                 | acts on                                               |
| ------ | ----------- | ------------------------------------ | ----------------------------------------------------- |
| Ctrl+C | Copy        | `pane.view(what=clip)`, `on: 'copy'` | the marked rows                                       |
| Ctrl+X | Cut         | `pane.view(what=clip)`, `on: 'cut'`  | the marked rows                                       |
| Ctrl+V | Paste       | `doc.move`, `on: 'paste'`            | the anchor row's paste target; nothing when no anchor |
| F2     | Rename      | `doc.move`, `on: 'rename'`           | the anchor row, when it is the only marked row        |
| Escape | Clear marks | `pane.view(what=mark)`               | —                                                     |

- **How the keys become live.** The documents editor's `init` sets
  `this.keymap = new KeyMap(hotkeys('documents', { … }))` and calls
  `watchKeymap('documents', () => this.keymap)`, as `editors/script.ts` does for its
  `script` rows. path.ux routes a keystroke to the focused area's keymaps before
  `screen.keymap`, and does not route one that landed in a text box; the search box and
  the rename box also stop their own keys.
- Ctrl+V records `doc.move` because the table binds a key to one action. After a Copy the
  handler runs `doc.copy` instead. The row's comment says so.
- Ctrl+V with no anchor row does nothing, since there is no target. It runs the same
  dirty-draft refusal as the menu before calling `exec`, and reports the sentence.
- The menu entries show these through `shortcutOf`, so each binding is written once. There
  is no global Ctrl+C, Ctrl+X, Ctrl+V or F2 binding to shadow.

### D13. After a move

- `doc.move` pushes `{ type: 'docs', action: 'moved', moves }` to every window from `run`,
  before returning, so it arrives before the record's `documents:wrote` broadcast.
- **No re-keying.** A `DocSession`'s `path` is `readonly` and its provider is built for
  that path, a `seenHash` held for a moved file would be stale once its links are
  rewritten, and a dirty draft's own links would never be rewritten. So a move never
  carries unsaved edits along:
    - Before calling `exec`, every tree gesture that moves (Paste after Cut, Rename…, the
      rename box, Ctrl+V, F2) is refused when a moved path, or a path under a moved
      folder, is in `draftPaths()`, the list Save All reads: "Save wiki/a.md first — it
      has unsaved edits." The menu shows it as `refused`; the box and the keys report it.
    - The sentence is built by one function in `renderer/rules/docbuffer.ts` beside
      `saveOffer`, so the menu, the box and the keys use the same words.
- On `moved`, each window:
    - drops the clean buffers and rich sessions held for a moved path;
    - maps `ui.docPath` through the move map, so the Wiki pane opens the file at its new
      path;
    - maps the subject of every pinned pane (`pin.ts`);
    - in every documents pane, maps expanded ids and marks through the move map, over both
      id schemes: `wiki:<path under wiki/>` and `wikidir:` in document mode, and `file:`
      and `dir:` in file mode.
- A move run from the palette or CDP skips the renderer's dirty-draft refusal. A dirty
  draft at a moved path then stays at the old path and its save is refused as gone.
  Recorded as a known limitation beside the undo one (D4).
- `doc.mkdir`, `doc.newFile`, `doc.copy` and `doc.move` also push
  `{ type: 'docs', action: 'reveal', paths }` to the window that ran them (`ctx.origin`).
  Its documents panes expand the ancestors of those paths and mark them, so pasted items
  arrive visible.
- **`bridge.ts` dispatches on `action`.** Today every `docs` push runs `saveAllDrafts()`.
  The handler moves into a small function, `docsEffect`, in a new
  `renderer/pathux/app/docseffect.ts` that `bridge.ts` calls: `saveAll` runs Save All,
  `moved` and `reveal` run the handlers above. A `moved` or `reveal` push saves nothing.
- Backlinks and `pathIndex` need nothing: they are rebuilt on the refetch every mutating
  command already causes, and D6 keeps every entity's id, which is what they are keyed by.
  `character:<id>` node ids stay ids, as `document-tree.md` requires.

### D14. Both trees show empty folders

- `walkFiles` does not change; the Skills tree (`skillTree`) uses it too.
- A new `walkDirs(dir): Promise<string[]>` in `src/main/session/core.ts` returns every
  directory under `dir`, workspace-relative, skipping `TREE_SKIP`, and stops at
  `TREE_MAX_FILES` entries.
- `fileTree(paths, cap, base, dirs = [])` gains a fourth argument and makes a `dir` node,
  with no children, for each listed directory that no file path already produced.
  `DocsPart.fileTree()` passes `walkDirs(root)`. `skillTree()` passes nothing and is
  unchanged.
- `DocTreeInput` gains `wikiDirs: string[]` (paths relative to `wiki/`), filled in
  `DocsPart.docTree()` (`src/main/session/docs.ts`) from `walkDirs` over the wiki
  directory. `wikiBranch` makes a `wikidir` node for each, including folders whose files
  are all non-markdown.
- Without this, `doc.mkdir` would appear to do nothing.

### D15. Tooltips

- Menu entries: the registry description (D1) unless the entry sets its own (Paste's note,
  D11; Cut and Copy set "Mark these to be moved by the next Paste" and "Mark these to be
  copied by the next Paste"). A refused entry shows the check's sentence or its `refused`
  text verbatim.
- Row titles (`rowTitle` in `rules/documents.ts`):
    - `wiki`: "`<path>` — double-click the name to retitle the page, F2 to rename the
      file. Ctrl-click or Shift-click to select several."
    - `file` under `FILE_ROOTS`: "`<path>` — double-click the name to rename the file.
      Ctrl-click or Shift-click to select several."
    - `dir`, `wikidir` under `FILE_ROOTS`: "`<path>` — F2 renames it. Ctrl-click or
      Shift-click to select several."
    - A row outside `FILE_ROOTS` keeps its path alone.
- The file rename box: "Type the new file name — Enter renames the file on disk, Escape
  leaves it as it was." The title rename box keeps its current tooltip.
- Dialog fields take the prop descriptions: `parent` "the folder to create it in", `name`
  "the name of the new folder" / "the file name, with its extension" / "a new name for the
  one item moved; empty to keep its name", `into` "the folder to put them in", `paths`
  "the files and folders, workspace-relative".

### D16. Out of scope

- **Deleting** files or folders, including an empty folder made by mistake (decided for
  now, item 2).
- **Dragging rows onto folders.** No todo asks for it, and it would break a rule the
  interaction layer keeps: an interaction's `targets` is the same function the drop's
  command runs (`src/shared/interactions.ts`). A drag verdict here could only apply the
  path rules, since the repository, media and identity rules need the disk, so the hover
  sentence and the drop's refusal would come from different functions. Cut and Paste cover
  moving.
- **Pasting in another window.** The clipboard is per window (D9).
- **An agent tool.** The agent cannot move files; a command with no tool wrapper is
  unreachable to it (CLAUDE.md, "Command system"). If one is added later, the planner in
  `src/shared/fileops.ts` and `FilesPart`'s disk rules move to a leaf package so both
  hosts run one rule.
- **Moving media** and **new top-level folders** (decided for now, items 1 and 3).
- **History across a move** (D5).
- **The Skills pane's tree.** `.aiagent/` is outside `FILE_ROOTS`.
- **Undo moving open editors back** (D4), and **palette moves carrying drafts** (D13).

## New and changed modules

| module                                                                    | change                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/shared/fileops.ts`                                      | New, pure: `FILE_ROOTS`, `fileNameProblem`, `rootProblem`, `planMove`, `planCopy`, `copyName`, `remapPath` |
| `apps/desktop/src/shared/docpath.ts`                                      | Moved from `renderer/pathux/doctree/docpath.ts`                                                            |
| `apps/desktop/src/shared/effects.ts`                                      | `VIEWS` gains `clip`                                                                                       |
| `apps/desktop/src/shared/ipc.ts`                                          | `UiEffect` gains `docs` `moved` and `reveal`                                                               |
| `packages/store/src/entities.ts`                                          | `discoverCandidates`, `entityIdentity`                                                                     |
| `packages/store/src/docfile.ts`                                           | `writeDocFile`'s doc comment names the relink write                                                        |
| `apps/desktop/src/main/session/files.ts`                                  | New `FilesPart`: disk rules, repository rules, the one move/copy method, rollback, `utimes`                |
| `apps/desktop/src/main/session/core.ts`                                   | `walkDirs`; the session delegates to `FilesPart`                                                           |
| `apps/desktop/src/main/session/docs.ts`                                   | `fileTree()` passes `walkDirs`; `docTree()` fills `wikiDirs`                                               |
| `apps/desktop/src/main/doctree/doctree.ts`                                | `fileTree`'s `dirs` argument; `DocTreeInput.wikiDirs`; `wikiBranch` draws them                             |
| `apps/desktop/src/main/doctree/relink.ts`                                 | New, pure link rewriting                                                                                   |
| `apps/desktop/src/main/commands/docfiles.ts`                              | New: the four commands, registered beside `doc.ts`'s                                                       |
| `apps/desktop/src/main/commands/doc.ts`                                   | `doc.create` gains `dir`                                                                                   |
| `apps/desktop/renderer/pathux/app/bridge.ts`, `app/docseffect.ts`         | `docs` pushes dispatched on `action`                                                                       |
| `apps/desktop/renderer/pathux/doctree/marks.ts`                           | New, pure marking rules                                                                                    |
| `apps/desktop/renderer/pathux/doctree/clipboard.ts`                       | New: the window's clipboard                                                                                |
| `apps/desktop/renderer/pathux/doctree/doctree.ts`                         | `menuFor` entries and its `ctx` argument                                                                   |
| `apps/desktop/renderer/pathux/doctree/treeview.ts`                        | Click modifiers, modifier clicks outside the double-click count, `marked` and `cut` classes                |
| `apps/desktop/renderer/pathux/editors/documents.ts`                       | Marks, file rename box, `moved`/`reveal` handlers, keymap                                                  |
| `apps/desktop/renderer/pathux/doctree/docbuffer.ts`, `docsession.ts`      | Dropping clean buffers and sessions for moved paths                                                        |
| `apps/desktop/renderer/rules/docbuffer.ts`                                | The unsaved-edits refusal sentence                                                                         |
| `apps/desktop/renderer/rules/documents.ts`                                | Row titles, row offers (mark), rename offers                                                               |
| `apps/desktop/renderer/rules/shortcuts.ts`                                | `documents` rows                                                                                           |
| `apps/desktop/renderer/rules/menus.ts`, `rules/situations/doctreemenu.ts` | Menu situations                                                                                            |
| `apps/desktop/renderer/rules/paletteonly.ts`                              | `doc.move` and `doc.copy` during stages 2–3 only                                                           |
| `apps/desktop/renderer/styles/treeview.css`                               | `marked` and `cut`                                                                                         |

## Stages

Each stage is one commit, green under `pnpm check`, `pnpm test` and `pnpm lint`. Every
stage that adds a command also runs `pnpm gen:command-table` (the `command-table.md` and
`command-namespaces.md` pair `pnpm lint` checks). Every stage that touches a rule module
or a menu runs `pnpm gen:uxmodel`. Every stage that adds a command or touches
`renderer/pathux/editors/**` re-runs the anchor sweep (`scripts/sweep-anchors.mjs` against
`examples/mySampleRepo`), since `anchors.json` pins the registry's ids. Each stage updates
the docs its change makes wrong, in the same commit.

### Stage 1 — Empty folders, New folder, New file

- Main:
    - `src/shared/fileops.ts` with `FILE_ROOTS`, `fileNameProblem` and `rootProblem`.
    - `walkDirs`, `fileTree`'s `dirs` argument and `DocTreeInput.wikiDirs` (D14).
    - `doc.mkdir` and `doc.newFile` in `commands/docfiles.ts`, over `FilesPart.mkdir` and
      `FilesPart.newFile`, with the `missing` repository refusal. `newFile` writes through
      `writeDocFile` with an empty `seenHash`. Both push `reveal`.
    - `doc.create` gains `dir`.
    - `discoverCandidates` and `entityIdentity` in `@vn/store`, used by `doc.newFile`
      (D6).
    - `UiEffect` gains `reveal`; `docseffect.ts` and the `bridge.ts` dispatch.
- Renderer:
    - `menuFor`: New folder… on `branch:wiki`, `wikidir` and `dir`; New file… on `dir`;
      New wiki page… on `wikidir` passes `dir`. `refused` from `rootProblem`.
    - The documents pane handles `reveal`.
- Tests:
    - `apps/desktop/src/shared/tests/fileops.test.ts`: every name refusal, the four roots,
      root folders themselves, skill tier paths.
    - `apps/desktop/src/main/tests/doctree.test.ts`: an empty folder in both trees; a wiki
      folder holding only an image; `skillTree` unchanged.
    - `packages/store/src/tests/entities.test.ts`: the agreement fixture (D6);
      `discoverEntities` answers as before.
    - `apps/desktop/src/main/tests/files.test.ts` (new; temp directory, real
      `CommandStack` with an `UndoJournal`): mkdir creates; mkdir's record has
      `undo.changed === false` and undo reaches the command before it; mkdir after an undo
      clears redo; newFile refuses a taken name, a media extension,
      `characters/x/character.md`, `locations/x.md` and a `missing` submodule; undo of
      newFile removes the file.
    - `apps/desktop/src/main/commands/tests/doc.test.ts`: `doc.create` with `dir` files a
      note there and refuses `dir` for other kinds.
    - `apps/desktop/src/main/commands/tests/affects.test.ts`: `doc.mkdir` and
      `doc.newFile` in `RUNS`.
    - `apps/desktop/renderer/pathux/app/tests/docseffect.test.ts`: `saveAll` saves; a
      `reveal` push saves nothing.
    - `apps/desktop/renderer/pathux/doctree/tests/doctree.test.ts`: the new entries per
      kind, and `refused` on `dir:scenes`.
- Docs: `document-tree.md` (the file tree lists empty folders; the menu table's rows for
  `branch:wiki`, `wikidir` and `dir`, and the stale "none" line for `wiki` and `file`),
  `command-system.md` (`doc.` namespace bullets for the two commands and `doc.create`'s
  `dir`; the undoable list; the note that these commands' checks enforce their `affects`).
- Verify by hand: `pnpm vndesktop`, make a folder in the Wiki branch and in file mode,
  make a page and a file in it, undo each.
- Shipped. What the implementation settled or changed:
    - `rootProblem(path, role)` allows a root as a folder and refuses it as an item (see
      D2). `planCreate(parent, name)` in `fileops.ts` runs the name and root checks
      together for both commands; the menu's `refused` calls `rootProblem` alone, since
      the name is not typed yet.
    - `DocTreeInput.wikiDirs` is optional, so existing callers and tests are unchanged.
    - `doc.newFile` opens the Wiki editor only for a text path (`isTextPath`); any other
      file is created and revealed but not opened.
    - `reveal` only expands every folder above the path and refetches the tree. Marking
      the new row waits for stage 3, which adds marks.
    - `doc.create`'s `dir` also refuses a folder that does not exist.
    - Undoing the first file put into an empty root folder, such as an empty `wiki/`,
      removes that root folder as well, because the snapshot before the write did not hold
      it.
    - No `doctreemenu.ts` situations were added: `MENU_NODES` already draws `dir`,
      `wikidir` and `branch:wiki`, so the new entries reach `ux-model.json` and the sweep
      without them.

### Stage 2 — Moving and copying in main

No UI. Both commands are reachable from the palette and CDP only, and are listed in
`paletteonly.ts` with the reason "Drawn by the documents pane's Paste and Rename entries
from stage 4; palette and CDP until then."

- `planMove`, `planCopy`, `copyName` and `remapPath` in `fileops.ts`.
- `FilesPart.transfer(paths, into, mode, name)`: D3's disk and repository rules, D6, the
  renames or copies, `utimes` on every destination file, `relink.ts` (D7) for moves, and
  rollback on any failure (D4).
- `doc.move` (with `name`) and `doc.copy`. `written` lists every source path, every
  destination file (files, not folders) and every file whose links were rewritten.
- `UiEffect` gains `moved`; `doc.move` pushes it and `reveal`; `docseffect.ts` ignores
  `moved` until stage 4.
- `docpath.ts` moves to `src/shared/`; renderer imports follow.
- `writeDocFile`'s doc comment is corrected (D7).
- Tests:
    - `apps/desktop/src/shared/tests/fileops.test.ts`: into itself; already there; `name`
      with several paths; same-name and case-only renames; two sources with one name;
      nested sources dropped; copy names `-copy`, `-copy-2` for files and folders.
    - `apps/desktop/src/shared/tests/docpath.test.ts` (moved).
    - `apps/desktop/src/main/tests/relink.test.ts`: inline links, images, titles,
      angle-bracket hrefs, reference definitions, fragments and queries, `%20`, code
      fences and inline code left alone, URLs and `#` left alone, a folder move, outbound
      links from a moved file (including a picture link into `assets/objects/`), and a
      file that both moves and links to another moved file.
    - `apps/desktop/src/main/tests/files.test.ts`:
        - moving a file and a folder, then undo and redo, restore the exact trees;
        - a rename by `name`, of a note and of a folder of tagged sheets, is accepted; of
          a tagged sheet, refused with D5's sentence;
        - moving into a folder made by `doc.mkdir`, then undo, removes the folder (D4);
        - copying, then undo, removes the copies;
        - refusals for an image, an image inside a folder, a symlink, a folder containing
          `.git`, a source in a nested repository moved into the project's repository, a
          destination in a `missing` submodule, and each D6 case;
        - acceptance of a tagged sheet moved within `wiki/`, of `locations/cafe.md` with
          `type: location` moved into `wiki/`, and of a move that changes which of two
          duplicates wins;
        - inbound and outbound links rewritten, and one undo restores both texts; a
          scene's link and a file under `archive/` left byte-for-byte unchanged; a note
          with unparseable front-matter does not block the move;
        - a rename failure part way through, and a linking file changed during the run,
          each leave the tree as it was (fault injected through a seam on `FilesPart`);
        - a file moved onto a path that earlier held a same-size file with the same mtime
          is captured with the new hash (D4, `utimes`).
    - `apps/desktop/src/main/commands/tests/docfiles.test.ts`: messages and `written`; the
      `moved` push happens before `run` returns.
    - `apps/desktop/src/main/commands/tests/affects.test.ts`: `doc.move` and `doc.copy` in
      `RUNS`.
- Docs: `document-tree.md` gains the "Moving, copying and renaming files" section with the
  rules as they now stand; `command-system.md` (the `doc.` namespace, the undoable list,
  and a sentence in "Undo is opt-in" that a move is representable because D3 refuses
  everything a snapshot skips).
- Verify by hand over CDP:
  `node scripts/vn-cdp.mjs "doc.move(paths=['wiki/a.md'] into='wiki/lore')"`, then undo
  and redo from the Edit menu, with a page linking to `wiki/a.md` open.
- Shipped. What the implementation settled or changed:
    - **D3 and D6 were wrong that main holds a loaded project.** Every session method
      calls `loadProject` afresh; nothing caches discovery. A move's check therefore runs
      `discoverCandidates` itself, but only when a moved markdown file starts or ends
      under `wiki/`, `characters/` or `locations/`. That reads every sheet's front-matter,
      which is more than "How much a check reads" allowed; it is the same read
      `loadProject` makes for most other commands' checks. A copy needs no discovery, only
      `entityIdentity` at each destination.
    - **D3 missed empty folders.** A folder that holds files and also an empty folder is
      refused, because undo would move the files back and leave the empty folder, and so
      its parent, at the destination. A folder with no files at all is accepted; like
      `doc.mkdir`, its move leaves no undo point. The temp sibling an interrupted atomic
      write leaves (`*.tmp-<hex>`) is refused too, since a snapshot skips it.
    - **Undoing a move into any empty folder removes that folder**, not only one made by
      `doc.mkdir`, for the same reason D4 gives.
    - **`doc.copy` rewrites each copy's own relative links**, which D7 reserved for moves.
      Without it a page copied into another folder had broken links. The move map for a
      copy is the copy map, so a link between two items copied together names the copy.
      Nothing under `archive/` is rewritten, as for a move.
    - `written`: for `doc.move`, each source as named, every source file, every
      destination file and every rewritten file; for `doc.copy`, the destination files and
      rewritten files only, since a copy writes nothing at its sources.
    - The media refusal says "is an image" only for image extensions; other media name
      their extension ("wiki/theme.mp3 is a .mp3 file…").
    - The fault seam is `FilesPart.step(stage, path)`, called before each item is placed
      and before each rewritten file is written.
    - A bare href is decoded with `decodeURI` and re-encoded only for `%`, whitespace,
      parentheses and angle brackets, so a rewritten href keeps non-ASCII names readable.
    - `docpath.test.ts` held the `doclinks` tests as well; those stayed in the renderer as
      `doctree/tests/doclinks.test.ts`, and only the `docpath` cases moved.

### Stage 3 — Multiselect

Renderer only.

- `renderer/pathux/doctree/marks.ts` (D10); `treeview.ts` passes modifiers, keeps modifier
  clicks out of the double-click count, and draws `marked`; the documents pane holds
  `marks` and `anchor`, handles Escape (the pane's `KeyMap`, D12) and applies the
  right-click rule. `rowAction` records `pane.view(what=mark)`; `rowTitle` gains the
  sentence.
- Nothing acts on more than one row yet; stage 4 adds Cut, Copy and Paste.
- Tests:
    - `apps/desktop/renderer/pathux/doctree/tests/marks.test.ts`: plain, Ctrl and Shift
      clicks; a Shift-click range skipping unmarkable rows and rows outside `FILE_ROOTS`;
      a click on an unmarkable row clearing; prune on refetch and on filter; right-click
      on a marked and an unmarked row.
    - `apps/desktop/renderer/pathux/doctree/tests/treeview.test.ts`: modifiers reach
      `onClick`; two quick Ctrl-clicks, or Shift-clicks, on one row do not fire
      `onSecondClick`; a plain click after a Ctrl-click does not either.
    - `apps/desktop/renderer/rules/tests/documents.test.ts`: the row offer's `then` and
      tooltip for markable rows only.
    - `apps/desktop/renderer/rules/tests/shortcuts.test.ts`: the Escape row.
- Docs: `desktop-app-editors-misc.md#documents` ("The tree owns no selection" becomes: it
  owns no app-wide selection, and holds the marked rows itself); `document-tree.md` (a
  short "Selecting several rows" section).
- Shipped. What the implementation settled or changed:
    - **`pruneMarks` takes the drawn rows and runs on every redraw.** A refetch and the
      filter drop marks as D10 says, and so does closing a folder, since the reason is the
      same: no act may take a row the author cannot see. The anchor is dropped with its
      row.
    - **A reveal marks what it names** (`revealMarks` in `marks.ts`), which stage 1
      deferred. The marks are applied when the refetch the reveal started returns.
    - **`remapMarks` waits for stage 4**, with the `moved` handling that calls it.
    - **A right-click on a row marked among several keeps the marks, but the menu is still
      the row's own**, with the row's label as its title, and the selection is published
      as before. The "3 items" title arrives with the multi-row entries in stage 4. A
      right-click on a row with no menu leaves the marks alone.
    - **Row titles leave out F2**, which does not exist until stage 5. A `wiki` row reads
      "`<path>` — double-click the name to rename it. Ctrl-click or Shift-click to select
      several.", and a `file`, `dir` or `wikidir` row reads "`<path>` — Ctrl-click or
      Shift-click to select several." D15's wording replaces them in stage 5.
    - `markable(node)` lives in `rules/documents.ts` beside `renameOf`, because `rowTitle`
      and `rowAction` need it there; `marks.ts` imports it. `rowTitle` takes `markable` as
      an option, as it takes `renamable`, and the Skills pane passes `false`.
    - A markable row's offer records `pane.view(what=mark)` last in `then`, after the
      `view.open` where there is one. The Documents situations gain a page, a wiki folder
      and an image file so the derived model draws that tail; the uxdocs fold count moves
      from 518 to 521.
    - Ctrl and Shift together act as Shift. Escape clears the marks and keeps the anchor.
    - `treeview.test.ts` tests `countClick` with modifiers and `modsOf`, not a dispatched
      click: the desktop jest project runs under node with no DOM.
    - Tree rows are `user-select: none`, so a Shift-click does not also select the text
      between the two rows.

### Stage 4 — Cut, Copy and Paste

- `clip` in `VIEWS`; `renderer/pathux/doctree/clipboard.ts`; Cut, Copy and Paste entries,
  single and marked (D11); Ctrl+C, Ctrl+X and Ctrl+V (D12); the `cut` class.
- The unsaved-edits refusal in `rules/docbuffer.ts`, used by Paste and Ctrl+V.
- `moved` handling in `docseffect.ts` and the pane: drop clean buffers and sessions, map
  `ui.docPath`, pins, expansion and marks (D13).
- The menu situations for a Cut and a Copy clipboard; the `paletteonly.ts` entries for
  `doc.move` and `doc.copy` are removed.
- Tests:
    - `apps/desktop/renderer/pathux/doctree/tests/doctree.test.ts`: Paste refused with an
      empty clipboard and with a dirty cut path; Paste's id follows the clipboard mode;
      labels for several items; the marked menu; Cut and Copy refused outside
      `FILE_ROOTS`.
    - `apps/desktop/renderer/pathux/doctree/tests/clipboard.test.ts`: a Cut pasted clears,
      a Copy pasted stays.
    - `apps/desktop/renderer/pathux/app/tests/docseffect.test.ts`: a `moved` push saves
      nothing and drops only clean buffers under the moved paths.
    - `apps/desktop/renderer/pathux/doctree/tests/docbuffer.test.ts`: dropping a clean
      buffer for a moved path; a dirty one is kept.
    - `apps/desktop/renderer/pathux/doctree/tests/marks.test.ts`: `remapMarks` over both
      id schemes.
    - `apps/desktop/renderer/rules/tests/docbuffer.test.ts`: the refusal sentence for a
      file and for a file under a moved folder.
    - `apps/desktop/renderer/rules/tests/shortcuts.test.ts`: the three rows.
- Docs: `document-tree.md` (the menu table, the clipboard, "Deliberately absent"; see
  [Docs after the plan](#docs-after-the-plan)); `command-system.md` (the effects paragraph
  names `clip` among `pane.view`'s values, if it lists them).
- Verify by hand: cut three pages in the Wiki branch, paste into a folder in file mode,
  undo, redo; try to cut and paste a page with unsaved edits and read the refusal; confirm
  an open page follows its move.
- Shipped. What the implementation settled or changed:
    - **Copy path shipped here.** D11 lists it but no stage claimed it. `app.copy`'s
      description now names a file's path beside the ids, so the entry's tooltip, which is
      the registry's text, is true of it.
    - **Clean buffers follow a move rather than being dropped.** `followMoves` in
      `docbuffer.ts` points each clean buffer showing a moved path at the new path and
      re-reads it there. Opening the new path releases the old session, which is then
      disposed, so `docsession.ts` needed no change. A dirty buffer stays at the old path.
    - **`ui.docPath` and pins are mapped in `bridge.ts`** (`followMove`), through
      `pinAfterMove` in `pin.ts`. A pin that moved saves the layout, as a pin the author
      set does. `docsEffect` runs the buffers first and then the `onMoved` listeners, so
      the Wiki pane's buffer is already on the new path when `ui.docPath` changes.
    - **Marks are not pruned while a fetch is out.** A `moved` push remaps expanded ids
      and marks (`movedId`, `remapMarks`) before the tree holding the new rows has
      arrived, so the pane refetches and prunes only once it lands. `movedId` leaves a
      `wiki:` id whose page moved out of `wiki/` unchanged, and the next redraw drops it.
    - **Paste runs through a pane handler and is still checked.** The entry carries
      `on: 'paste'`, which `needsCheck` ignores, so the menu asks `stack.check` as before;
      the handler runs `exec` and empties the clipboard once a Cut's move has landed. With
      an empty clipboard the entry records `doc.move`.
    - **Ctrl+V uses the menu's own entry.** `pasteEntry` in `doctree.ts` is exported, and
      the key handler reads its `refused` and its id, so the menu and the key cannot give
      different answers. The dirty-draft sentence is `unsavedRefusal` in
      `rules/docbuffer.ts`, as planned.
    - **The marked menu's Paste is labelled "Paste into lore"** and follows the
      clipboard's mode like the single-row entry. The menu's title is "3 items".
    - **Menu situations.** The `doctree` row's state is now `{ nodes, ctx }`, with the
      situations in `rules/situations/doctreemenu.ts`: `every-kind` (unchanged nodes, an
      empty clipboard), `cut-clipboard`, `copy-clipboard` and `three-marked`. The empty
      clipboard's sentence is new in the model, so the uxdocs refusal count moves from 99
      to 100. The anchor sweep went from 664 to 700 records: 36 new menu records and none
      removed.
    - **A cut row dims only its label**, so the marked and selected tints still show
      behind it.
    - **Found while verifying:** after an undo removed a moved page and a redo put it
      back, the Wiki pane kept the undo's "no such file" note, because `DocBuffer.follow`
      returned early when the file came back with the hash its session already held. It
      now clears a failed read's note in that case.

### Stage 5 — Renaming files and folders in the tree

- "Rename…" and "Rename file…" entries (D11); a `renamePathOf(node)` beside `renameOf` in
  `rules/documents.ts`; the inline box, prefilled with the file name (not the title, on a
  `wiki` row) and committed with `doc.move` and `name`; double-click on a `file` row opens
  that box; F2 (D12). The box and F2 run the unsaved-edits refusal before `exec`.
- Tests:
    - `apps/desktop/renderer/rules/tests/documents.test.ts`: `renamePathOf` per kind; row
      titles.
    - `apps/desktop/renderer/pathux/doctree/tests/doctree.test.ts`: the rename entries,
      their `refused` outside `FILE_ROOTS` and with unsaved edits.
    - `apps/desktop/renderer/rules/tests/shortcuts.test.ts`: the F2 row.
- Docs: `document-tree.md` "Renaming in place" gains the file rename (D5), and states that
  a double-click on a page still retitles it.
- Shipped. What the implementation settled or changed:
    - **path.ux's keymap names no function keys**, so D12's F2 row could not become a
      `HotKey` as written. `rules/shortcuts.ts` gains `FUNCTION_KEYS` (`F2` and main's
      `F12`) and `isFunctionKey`; `hotkeys()` in `pathux/app/keymap.ts` builds such a
      `HotKey` and sets its `key` code directly, and the sweep's shortcut report reads the
      same table. path.ux itself is unchanged: an enum entry there would be a submodule
      commit that exists only in this worktree's module store until it is pushed.
    - **The rename entries carry their own tooltips.** D15 falls back to the registry's
      sentence, but `doc.move`'s is about moving; each kind says what its rename changes
      ("Change the page’s file name on disk and keep its title. Links to it are
      rewritten."). The rename boxes use D15's sentence, with "folder" for a folder.
    - **`renamePathOf(node)`** answers `{ path, name, into, folder }` for a `wiki`,
      `wikidir`, `file` or `dir` row with a path, including one outside `FILE_ROOTS`, so
      the entry can be drawn and greyed there. `renameEntry(node, ctx)` in `doctree.ts`
      builds Rename… and Rename file… and is exported, so F2 and the double-click read its
      `refused` the way Ctrl+V reads Paste's. `fileRenameAction` is the box's offer, and
      the Documents situations gain `renaming-file`; the uxdocs fold count moves from 521
      to 522.
    - **Both boxes are one `openBox`** in `editors/documents.ts`. The file-name box
      selects the name up to its extension, and checks `unsavedRefusal` again at Enter as
      well as before it opens.
    - **A sheet's refusal arrives at Enter.** The rename entry supplies `name`, so it is
      not checked, and D5's sentence comes from `doc.move`'s own check when the box
      commits.
    - **A double-click on a `file` row renames only a markable row.** A file outside the
      four roots keeps its old double-click (nothing), which matches its tooltip, the path
      alone.
    - **The anchor sweep stayed at 700 records.** Menu records are one per command per
      row, and Paste already recorded `doc.move` on every row that gained Rename…, so the
      new entries add none. The sweep's shortcut report agrees with the table in every
      scope, F2 included.
    - **Found while verifying:** F2, like the pane's other keys, reaches the tree only
      while path.ux treats the tree as the active area. After a click opens a page in
      another pane, that pane is active until the pointer moves back over the tree.

## Docs after the plan

What `docs/reference/document-tree.md` should say once stage 5 lands:

- **Right-click menus:** the table in D11 replaces the rows for `branch:wiki` and
  `wikidir`, adds rows for `wiki`, `dir` and `file`, and the "none" row keeps only
  `branch:assets`, `assetkind` and `more`. The bullet "A kind with no actions is named
  rather than skipped" is rewritten: nothing binds to a page, and its entries are file
  acts.
- **A new section, "Moving, copying and renaming files":** the four roots and the
  repository boundary (D2), the refusals and how much a check reads (D3), identity (D6),
  links and `archive/` (D7), the clipboard (D9), marking several rows (D10), and what undo
  does and does not restore (D4): the new folder the first undo inside it removes, the
  redo a New folder clears, and the editors undo does not move back. It states that Show
  history of a moved file starts at the move.
- **The file tree section:** both trees list empty folders.
- **Renaming in place:** a page's double-click retitles it and F2 or "Rename file…"
  renames the file; a sheet's file cannot be renamed, and why.
- **Deliberately absent:** "Moving and deleting through the tree" becomes "Deleting and
  dragging through the tree". Moving is no longer absent. The original objection was that
  a drag would open a write path around the `story.*` refusals. That does not apply to
  these commands, because `scenes/` is outside `FILE_ROOTS` and each is a registered
  command with its own check. Deleting stays absent because undo cannot restore what the
  snapshot skips, and because deleting a sheet removes an entity. Dragging stays absent
  for the reason in D16.

`docs/reference/command-system.md`:

- `doc.` namespace: one bullet each for `doc.mkdir`, `doc.newFile`, and `doc.move` /
  `doc.copy`; the `doc.create` bullet mentions `dir`.
- The undoable list ("the eighteen `story.*` ones plus `doc.write`, …") gains the four.
- "Every mutating command declares what it may touch": one sentence saying the file
  commands' checks refuse outside their declaration.

`docs/reference/desktop-app-editors-misc.md#documents`: the pane holds its marked rows,
and the window holds a clipboard; neither is persisted.

`CLAUDE.md`: no change. No effect is added (`clip` is a new `pane.view` value and the
count stays twelve), and nothing here changes an invariant CLAUDE.md states.

## Decided for now

These were open questions in the first draft. Each is decided on the recommendation and
can be reopened.

1. **Images are refused** by every file command, because undo does not hold them and the
   todo requires moves to be undoable. An author reorganizing `characters/aiko/refs/` uses
   Explorer. A separate `confirm: true`, non-undoable move for media is the option if
   someone asks.
2. **Nothing deletes.** A folder made by mistake stays until it is removed outside the
   app. A follow-up `doc.removeDir` that deletes an empty folder only is the option, since
   the snapshot holds nothing for one; a general delete stays absent.
3. **The four roots are `wiki/`, `characters/`, `locations/` and `archive/`.** New folders
   at the project root, and moves into `.aiagent/`, `scenes/` or `vngen/`, are refused.
   Allowing a free top-level folder would mean widening the closed `affects` vocabulary
   with an open-ended entry.

## Review

A fresh-context agent attacked the first draft. Each finding and its answer:

1. **Moves could cross repositories** (a submodule `wiki/`, possibly shared; nested
   repositories; an unchecked-out submodule is an empty directory). Fixed: D2 and D3
   refuse a move or copy whose source and destination are in different repositories
   (`RepoResolver.rootOf`), and every file command whose destination is in a `missing`
   repository, with both sentences. Tests in stages 1 and 2.
2. **`bridge.ts` runs Save All for every `docs` push.** Fixed: D13 moves the handler into
   `docseffect.ts`, dispatched on `action`; `bridge.ts` is in the module table; a test
   shows `moved` and `reveal` save nothing.
3. **Re-keying a rich `DocSession` does not work** (`readonly path`, a per-path provider,
   a `seenHash` stale after relinking, a dirty draft's links never rewritten). Fixed: D13
   drops re-keying. Tree gestures that move refuse a path with unsaved edits before
   `exec`, using `draftPaths()`; after a move the renderer drops clean buffers and maps
   `ui.docPath` and pins. The undo limitation and the palette limitation are recorded.
4. **Dragging breaks the rule that `targets` is the function the drop runs, and no todo
   asks for it.** Fixed: the first draft's dragging decision and its stage 6 are cut; D16
   lists dragging as out of scope with that reason.
5. **The `paletteonly.ts` claim was wrong.** Fixed: D11 names which situation draws each
   command and how `uxmodel.test.ts` is met, and `doc.move` and `doc.copy` are listed in
   `paletteonly.ts` for stages 2 and 3 only.
6. **Registry descriptions would be false between stages** (link rewriting came after
   moves). Fixed: link rewriting is in stage 2 with `doc.move`, before any UI can move.
7. **Relinking through `writeDocFile` lets one broken note block every move, and
   `archive/` must stay verbatim.** Fixed: D7 rewrites bytes directly with a hash
   comparison and `writeFileAtomic`, with no front-matter parse or size refusal; a file
   that changed fails the run and rolls back. `archive/` is never scanned or rewritten.
8. **Cut and Copy were enabled outside the roots, and an entry for a command with no check
   resolves `undeclared`.** Fixed: only rows inside `FILE_ROOTS` can be marked (D10); Cut
   and Copy are the effect `pane.view(what=clip)` (D9), which is never checked, so they
   carry `refused` from `rootProblem` outside the roots (D11). `clip` is a new `VIEWS`
   value, so the effect count and CLAUDE.md do not change.
9. **Marked and selected rows looked the same.** Fixed: a `marked` class; `sel` keeps
   meaning the published selection (D10).
10. **Two quick Ctrl-clicks opened the rename box.** Fixed: modifier clicks neither count
    toward nor fire `onSecondClick` (D10), tested in `treeview.test.ts`.
11. **Empty folders were underspecified.** Fixed: D14 keeps `walkFiles`, adds `walkDirs`,
    a `dirs` argument to `fileTree`, and `DocTreeInput.wikiDirs` filled in
    `session/docs.ts`, which is in the module table.
12. **A main-side clipboard was over-built.** Fixed: the clipboard is per window in the
    renderer (D9); Paste is `doc.move` or `doc.copy` with full props; `doc.paste`,
    `doc.clip`, `doc.clipboard`, `remapClip` and the `clip` push are gone; renaming is
    `doc.move` with `name`. Four new commands remain.
13. **Paste's check reads the disk on every right-click.** Answered in D3 ("How much a
    check reads"): the full check stays, so a refusal is visible before acting, and is
    bounded to the named paths and their subtrees. `command-system.md` does not forbid
    disk reads in a check (`doc.write` and `doc.rename` read the file they name) and says
    a slow check is fixed rather than skipped.
14. **Stage 3 of the first draft was too big.** Fixed: five stages — folders and new
    files; moving and copying in main with relinking; multiselect; Cut, Copy and Paste;
    renaming in the tree.
15. **History and identity edges.** Fixed: D5 states that history starts at the move. D6
    compares against discovery's current candidates through `discoverCandidates`, mirrors
    the top-level `locations/` rule and `tagConflict`, accepts a move that changes which
    duplicate wins, and has an agreement test covering those cases.
16. **New folder drops redo.** Answered: `doc.mkdir` stays mutating; D4 and the docs state
    that it clears redo like any other act.
17. **`ContentStore.seen` could be stale after `fs.rename`.** Fixed: D4 sets each
    destination file's mtime to now with `utimes`; a stage 2 test covers the same-size,
    same-mtime case.
18. **Out-of-date statements.** Fixed: the introduction says `wiki` and `file` rows
    already have Show history; stage 1 corrects `document-tree.md`'s table line; stage 2
    corrects `writeDocFile`'s doc comment.
19. **Smaller points.** Fixed: Ctrl+V with no anchor does nothing (D12); `written` lists
    every source, every destination file and every relinked file (stage 2); D12 states how
    the `documents` keymap becomes live (`this.keymap` with `hotkeys('documents')` and
    `watchKeymap`, as `script.ts` does); `rules/docbuffer.ts` is in the module table; the
    registry descriptions were reworded so no command or file is the subject of an act it
    cannot perform.
