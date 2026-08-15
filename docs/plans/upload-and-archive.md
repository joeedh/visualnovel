# `/upload`: bringing an author's own documents in

Status: **planned**

## Context

Three items in `todos.md`, one feature:

> - create a /upload command for the agent that lets the user select files to upload. the agent
>   will automatically switch to plan mode and ask the user what to do with the files. to start
>   with we will only support text files, but eventually the plan is to also support zip files,
>   word documents, and possible openoffice writer files (but that's long term). btw when
>   importing files, the agent should always commit the original files to the repo in a special
>   archive folder that's not indexable or searchable by the agent unless requested by the user.
>   if necassary we could commit them to the git history and delete the files in another commit.
> - the /upload command should, on importing files, give suggestions to the user (not based on the
>   file contents) on how to write the next use prompt, e.g. 'what should I do with these (e.g.
>   'integrate into the wiki').
> - create a main menu item to import files. it will activate or create a conversation editor in a
>   new thread, autofill it with an /upload command and visually highlight the conversation editor
>   somehow (briefly flashing border?).

The name is `/upload` rather than `/import` deliberately: `vngen import` and `workspace.import`
already mean *convert a retired screenplay into scene chunks*, and two meanings of "import" in one
app is a support burden forever.

The "not indexable or searchable" requirement turns out to be **free**, which is worth knowing
before designing anything: `collectInputFiles` (`packages/authoring/src/tools.ts:175`) walks an
**allow-list** — `['characters', 'locations', 'scenes', 'screenplay']` plus two named files — so a
new top-level directory is invisible to `search` without a line of code. `loadInputs` discovers
entity sheets in `characters/`, `locations/` and `wiki/**` only, and `openBible` reads `wiki/`, so
an archive kept **outside `wiki/`** is also invisible to entity discovery and to `bible.search`.
Meanwhile `read_file` reads any workspace file, bounded and text-only. That is exactly the
requested policy — invisible to sweeps, readable when the author names it — and it falls out of
the existing shapes rather than needing a new permission concept.

This plan depends on [`conversation-threads.md`](conversation-threads.md): "a conversation editor
in a new thread" has no meaning until threads exist.

## Decisions this plan settles

- **The archive is `archive/` at the project root, and the originals stay there.** Not under
  `wiki/` (entity discovery and the bible both walk it), not under `vngen/` (that tree is the
  reproducible output of a run; an author's source document is an input). The todo's alternative —
  *commit them, then delete them in another commit* — is rejected: the bytes are in history either
  way, so it saves no space; the originals become invisible to the author as well as to the agent;
  and recovering one needs `git show` plumbing that nothing in the app has a surface for. An
  archive you can open in Explorer is worth more than one you have to excavate.
- **Layout is `archive/<yyyymmdd-hhmmss>-<slug>/<original filename>`**, one directory per upload
  batch, filenames preserved. A flat directory collides on `notes.md`; a hash-named file loses the
  only handle the author has on it.
- **Text only, and the refusal names the format.** A `.docx`, `.odt` or `.zip` is archived
  *unchanged* — the bytes are safe — but reported as "archived, not yet readable: no converter for
  .docx". The long-term plan is a converter step that writes a text sidecar beside the original
  (`notes.docx` → `notes.docx.txt`), leaving the original untouched. That seam is stated now so the
  archive layout does not have to change later.
- **The agent is put into plan mode by the upload, not asked to put itself there.** `setMode` is
  already a session method and a command. A model that decides for itself whether to plan is a
  model that sometimes does not.
- **The suggestions are content-blind and generated from the file list alone** — count,
  extensions, total size, whether names look like scenes. Deliberately: reading the contents to
  suggest a prompt costs a model call to produce a sentence the author is going to rewrite anyway,
  and the todo says so explicitly.
- **The suggestions are chips that fill the composer, not messages that are sent.** The point is
  to teach the shape of a good next prompt; sending it removes the moment where the author edits
  it into what they actually meant.
- **The archive is committed like any other act.** `Committer` already takes the whole worktree
  per repo, so the copy lands in the commit for the command that made it. No special-casing.
- **Both surfaces reach one function.** `archiveUpload()` in `@vn/authoring` (which the desktop
  session and the REPL both already import) does the copying and returns the manifest; the desktop
  wraps it in a command, the REPL in `/upload`. Two implementations of "where does an uploaded file
  go" is how the two surfaces end up with two archives.

## Stage 1 — the archive

New `packages/authoring/src/archive.ts`:

```ts
export interface UploadedFile { source: string; stored: string; bytes: number; readable: boolean; note?: string }
export interface UploadBatch { dir: string; files: UploadedFile[]; skipped: { source: string; reason: string }[] }
export const ARCHIVE_DIR = 'archive';
export async function archiveUpload(workspace: Workspace, files: string[], at: Date): Promise<UploadBatch>;
export function uploadSuggestions(batch: UploadBatch): string[];
```

- Refuses a file that is not a regular file, one over a size cap, and one already inside the
  workspace (archiving a project file into the project is always a mistake).
- `readable` is true for the extensions `read_file` will serve (`.md`, `.txt`, `.fountain`,
  `.yaml`, `.json`, `.csv`); everything else is archived with a `note`.
- `uploadSuggestions` returns three or four sentences from a small table:
  *"Summarize these and file them under `wiki/`."* /
  *"Turn the people described here into character sheets."* /
  *"Extract any scenes into `scenes/`, one file each."* /
  *"Read them and tell me what's inconsistent with the story bible."*
  The set is chosen by extension and count, never by content.

New tool `list_archive` (read-only) in `tools.ts`: the archive's batches and their files, so the
agent can see what just arrived without a walk it is not allowed to do. `read_file` already serves
the contents, so no second reader is added — and `INPUT_GLOBS` is left exactly as it is, which is
what keeps the archive out of `search`.

Tests: `packages/authoring/src/tests/archive.test.ts` — batch layout, name preservation, the
non-text note, refusals, and a case asserting `search` finds nothing in an archived file while
`read_file` reads it. That last one is the requirement, stated as a test.

## Stage 2 — the desktop command

`apps/desktop/src/main/commands/` gains an `upload` namespace (kept apart from `asset.upload`,
which brings *images* into the content-addressed store — a different noun and a different
destination):

| command | what |
| --- | --- |
| `upload.files(paths='a;b' …)` | Archive the named files, commit, and hand the agent a seeded turn |
| `upload.pick` | The file dialog in front of `upload.files`, multi-select — the `workspace.pick` pattern, including its re-check after the dialog ("the dialog is not a permission") |

`run` does, in order: `archiveUpload`, `session.setMode('plan')`, start a new thread
(`session.newThread()`), and push a `command:ui` effect opening/focusing the `convo` editor. The
seeded first message is written by the command, not by the model:

> Uploaded 3 files to `archive/20260815-142233-notes/`: `worldbuilding.md`, `cast.txt`,
> `timeline.md`. What should I do with them?

followed by the suggestion chips. `confirm: true` — it copies bytes into the repo from paths the
author named, which is the same bar `asset.upload` clears.

## Stage 3 — the shell

- `header.ts`, `appMenu()`: **Upload Files…** → `openPalette('upload.pick')`, beside the project
  entries.
- `editors/convo.ts`: renders the suggestion chips under the seeded message; clicking one fills
  the composer (and does not send). A new `UiEffect` action or a flag on the existing `view` one
  makes the convo pane **flash its border** once when it is opened this way — the todo's "visually
  highlight", implemented as a 600ms outline animation in `styles/`, on the pane's own frame, once
  per effect and never repeating. An effect that reaches a pane that is already focused still
  flashes; that is the case it exists for.

## Stage 4 — the REPL

`apps/authoring/src/repl.ts`: `/upload <path> [path…]` beside `/makeimage`, calling the same
`archiveUpload`, printing the batch and the numbered suggestions, and switching to plan mode. No
file dialog — a terminal has paths. This is what keeps `@vn/authoring` the owner of the behaviour
rather than the desktop.

## Stage 5 — documentation

- New section in `docs/vnauthor.md`: the archive, what is and is not visible to which tool, and the
  `/upload` command.
- `docs/desktop-app.md`: the menu entry, the seeded thread, the flash.
- `docs/story-bible.md`: one sentence that `archive/` is *not* the bible and is not reached by
  `query` — the two are easy to confuse and only one of them is retrievable.
- `CLAUDE.md`: a bullet — an uploaded document is archived verbatim under `archive/`, invisible to
  `search` and to entity discovery because both walk allow-lists, and readable by name.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- **Upload Files…** with three text files: they appear under `archive/<stamp>-<slug>/` with their
  original names, in one commit, and a fresh convo thread opens with the seeded message, the chips
  and a flashed border, in plan mode.
- `search` for a phrase that occurs only in an archived file returns nothing; `read_file` on that
  path returns it.
- A `.docx` is archived and reported as not yet readable; nothing throws.
- `/upload` in the REPL produces the same archive layout as the desktop command.
