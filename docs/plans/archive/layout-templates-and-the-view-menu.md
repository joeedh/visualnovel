# Layout templates, and a View menu that has room for them

Status: **shipped**. This is the as-built record; where the plan and the code disagree, the
code is right and the difference is called out under [Deviations](#deviations).

<!-- toc -->

- [Why](#why)
- [The View menu](#the-view-menu)
- [The template format](#the-template-format)
  - [Recipe or screen, and why both](#recipe-or-screen-and-why-both)
  - [The two shipped layouts](#the-two-shipped-layouts)
- [Where templates live](#where-templates-live)
- [The commands](#the-commands)
- [Applying, saving, resetting, undoing](#applying-saving-resetting-undoing)
- [The merge policy](#the-merge-policy)
- [Digest props in a form](#digest-props-in-a-form)
- [Files](#files)
- [Verification](#verification)
- [Deviations](#deviations)

<!-- tocstop -->

## Why

The View menu was flat: twelve editor entries, then Close Pane and Reset Layout. Every editor
added made it longer, and there was nowhere to put a second kind of view act.

At the same time the shell had exactly one arrangement — `buildDefaultScreen()` — and the only
thing an author could do with a layout they had built was keep it, because the live mesh is
remembered per install in `.vndesktop/session.json` under `pathux.layout` and nothing else could
name it. Writing prose, directing art and watching the result want different screens, and
switching between them was a manual re-split every time.

So: the editor entries move into a **View ▸ Editors** submenu, and **View ▸ Layout** gains named
arrangements the project owns.

## The View menu

```
View ▸
  Editors ▸  Branches, Script, Convo, Coverage, Tasks, Task Graph,
             Inspector, Play, Wiki, Documents, Asset, Project
  Layout  ▸  Writing ✓
             Art
             …any the author saved…
             ──────────────
             Save Current Layout As…
             Reset View Layout…
  ──────────────
  Close Pane
  Split Area
```

`Split Area` moved here from the app menu — it is a view act, and the app menu was the longer of
the two. Top-level `Reset Layout` is gone; `Reset View Layout…` inside Layout replaced it, and
the old command survives as the palette-only escape hatch (see `view.layout` below).

Submenus are `Menu` **instances** placed in the parent `MenuTemplate`. `createMenu` files its
title under the `name` attribute while the parent row reads `.title`, so `submenu()` in
`header.ts` sets `.title` and `.tooltip` explicitly — without the former the entry draws as a
blank full-width strip.

Every entry uses path.ux's **object form** (`{ name, callback, tooltip, id }`) rather than the
positional 3-tuple, so the mandatory tooltip has somewhere to go without counting commas. The
tooltip says the consequence: an editor entry is "Show the script, line by line, in this pane";
a layout row is "Rearrange the window: " plus the template's own description; a template that
cannot be applied says "Cannot be used: " plus the reason, and is still drawn.

The layout list comes from main, so the header fetches it exactly the way `refreshRecents()`
fetches the recent-projects list — a cached array, a guard, one `exec('view.layouts')` that calls
`rebuild()` when it answers. The active slug and the list's fingerprints join `stateKey()`, so the
bar redraws when a layout file moves under it and not otherwise.

## The template format

`.vnstudio/layouts/<slug>.json`, pretty-printed with a trailing newline:

```json
{
  "vnstudio": "layout/1",
  "slug": "writing",
  "title": "Writing",
  "description": "The documents tree, the script with the branch cards behind it, and the agent.",
  "editors": ["documents", "script", "branches", "convo"],
  "source": "shipped",
  "recipe": { "split": "columns", "at": 0.6, "first": { "…": "…" }, "second": { "pane": ["convo"] } }
}
```

`vnstudio` is the envelope version — this file's shape, not the path.ux schema, which lives inside
`screen` when there is one. The **slug is the filename**, so renaming the file renames the
template. `editors` is derived at write time: it is both a summary a list can show and a
pre-check, because a template naming an editor this build has not got is refused by name rather
than restored as something else.

`source` is `shipped` or `saved`, and it is what `view.resetLayout(scope='all')` reads to decide
what it may delete.

### Recipe or screen, and why both

Exactly one of `recipe` and `screen` is present; a file holding both is refused, because only one
of them can be right.

- A **recipe** is declarative — `{split, at, first, second}` down to `{pane: [editorId, …]}`. The
  shipped layouts are recipes because **main writes those with no renderer in the loop**:
  scaffolding a new project, ensuring an old one, and resetting all happen in the main process,
  and only a live screen can produce the other form.
- A **screen** is path.ux's own `simple.saveFile` blob. That is what `Save Current Layout As…`
  writes, because an author drags borders into arrangements no split grammar describes, and
  per-pane state (the Documents editor's `mode`) has no recipe representation at all.

Both halves are real and both were exercised live: the shipped recipes apply from files main
wrote alone, and a four-pane mesh no recipe describes round-tripped through a saved blob.

`recipeProblem` is the recipe's validator and `buildable()` (already in `persist.ts`) gates a
screen, so either form is refused with a sentence rather than half-applied.

### The two shipped layouts

| slug      | arrangement                                                                |
| --------- | -------------------------------------------------------------------------- |
| `writing` | Documents (0.3) \| Script over Branches, then Convo at 0.6 — today's default |
| `art`     | Documents (0.3) \| Asset, then Tasks over Task Graph at 0.7                  |

`DEFAULT_RECIPE` **is** the Writing recipe, and `buildDefaultScreen()` builds it — there is one
definition of that arrangement, not two, so the shell's default and the Writing template can
never drift.

A pane listing more than one editor shows the **first**. Building a pane means switching editors
into it in turn, which naturally leaves the last one showing, so `buildScreen` switches back to
the head afterwards. That is a small deliberate change from the old default (which came up on
Branches) and it is what makes the shipped descriptions true.

## Where templates live

In the **project repo**, because a layout is part of how a particular story is worked on: it
commits, it travels to a collaborator, and it is inside the undo pathspec. The **live** mesh stays
per install in `.vndesktop/session.json` under `pathux.layout` — the template is the saved
arrangement, not the one you are looking at. `pathux.template`, beside it, is the pointer between
them: the slug last applied, restored at boot and reported as `active` by `view.layouts`.

`ensureLayouts(root)` makes the directory, writes any shipped file that is **missing**, and
appends the merge policy to `.gitattributes`. It never overwrites: an author who edited
`writing.json` keeps the edit, and putting it back is `view.resetLayout`'s job rather than
something opening a project does. Writing outside a command is precedented — `openWorkspace`
already writes `project.yaml` into a directory that has none — because this is bootstrapping the
shape of a project, not editing a document.

It is called from `app.whenReady()` rather than only from `openWorkspace`, because neither
`--project`/`VN_PROJECT` nor the recents branch goes through `openWorkspace` and those are the
normal launch paths. Without that call the files never landed.

A **new** project does not wait for that: `skeleton()` writes the shipped layouts and the
`.gitattributes` alongside the three files that make its model build, so they land in the first
commit under the subject that says what they are. An **existing** project gets them from
`openWorkspace`, which calls `ensureLayouts` *before* `ensureRepo` so they are committed with
whatever else opening the project wrote rather than left dirty in the worktree — and commits them
itself, under "Add the shipped layout templates", when the repo was already there. That is the
same shape `ensureGitAttributes` uses for the notification log's `merge=union` line, which is the
other rule in the same file; the two ensures append independently and neither overwrites the
other's work.

That commit is conditional on `ownsRepo(root)`, and the condition is not theoretical: opening a
scratch folder inside a checkout of this monorepo filed both scaffolding commits onto its master,
because `isRepo()` is true of a directory that merely sits inside a work tree. The layouts are
still written — they are the project's files wherever the project lives — but a repo the project
does not own gets no history from the app. See
[`repos-and-commits.md`](../../repos-and-commits.md#the-gitattributes-a-project-gets).

A project that predates the feature needs none of this to work either: a shipped layout **with no
file** still appears in the list and still applies, answered for by its recipe.

`.vnstudio` is on the document tree's skip list beside `.git` and `node_modules`. The View menu is
where a layout is named; a JSON mesh is not a document anyone opens in an editor.

## The commands

All in `apps/desktop/src/main/commands/view.ts`.

| id                | mutating | undoable | props           | what it does                                                                                       |
| ----------------- | -------- | -------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `view.layouts`    | no       | —        | none            | `data: { active, layouts }` — every template with its title, description, source and fingerprint.    |
| `view.applyLayout`| no       | —        | `name`          | Rearranges the window. Sets `pathux.template`. Refuses a missing, unreadable or conflicted one.      |
| `view.saveLayout` | **yes**  | **yes**  | `name`, `layout`| Writes the envelope under a slug derived from `name`. `layout` is `digest: true`.                    |
| `view.resetLayout`| **yes**  | **yes**  | `scope`         | Rewrites the shipped files; `all` also deletes the author's. `confirm: true`. Re-applies afterwards. |
| `view.layout`     | no       | —        | none            | **Kept, retitled** "Rebuild the default arrangement" — the escape hatch, ignoring files entirely.    |

`view.applyLayout` is deliberately **not** mutating and not undoable: which panes you have open is
a window fact remembered per install, so applying a template writes nothing in the project and
undo has nothing to restore.

`view.saveLayout`'s `check` refuses a name with nothing sluggable in it and an arrangement that
will not parse, and its accept-note names the file — `writes .vnstudio/layouts/draft.json`, or
`replaces the Draft layout at …` when one is already there. Overwriting is allowed and is one undo
away, so it is a note rather than a refusal.

`view.resetLayout` is `confirm: true` because it clobbers files, and its note counts what survives:
`rewrites the shipped layouts and leaves the 1 you saved yourself alone`. `scope='all'` says
`deletes the 1 you saved yourself` instead — two words rather than one flag, because "reset" on its
own does not promise a deletion.

## Applying, saving, resetting, undoing

`Shell.applyLayout(file)` is the one door onto a new screen, and it **refuses before it discards**
— a template that will not build must not leave a blank window:

1. Gate — `recipeProblem` for a recipe, `buildable` (inside `loadScreen`) for a saved mesh.
2. Build: `buildScreen(recipe)`, or `loadScreen(this, file.screen)` over `simple.loadFile`.
3. `settleScreen()`, shared with `rebuild()` and the boot path: `ensureHeader` (a stored blob may
   predate the header), `completeSetCSS()` + `completeUpdate()` (the blob carries the size it was
   saved at and `update` rescales, so nothing computes one), `watchLayout` (`onLayoutChange` is not
   in `STRUCT`, so a screen that replaced another starts with no hook) and `saveLayout`.

The old screen is **destroyed**, not merely dropped — it holds window listeners, and two live
screens both answering the pointer is the shape of a haunted layout. The blob path destroys it
*after* the new one is up, because `loadFile` unlistens and removes but never destroys.

**Saving** is composed in the renderer and filed by main: `header.saveLayout()` reads the editor
list off the mesh, calls `currentLayoutFile`, and opens
`openCommandDialog('view.saveLayout', {layout})` with the blob pre-filled. The dialog collects only
the name; `currentLayoutFile` deliberately leaves `slug` and `title` empty, because main derives
both from that name and a second answer here is how a file starts disagreeing with what it is
called.

**Reset** writes the files, then re-reads whatever `pathux.template` names (falling back to
`writing`) and pushes the same `apply` effect, so the window is never left showing an arrangement
no file describes any more.

**Undo** restores the shadow tree, so the author's template files come back — but nothing pushes a
`view` effect, because no `view.*` command ran. What notices is the **fingerprint**:
`renderer/pathux/layouts.ts` records the slug and fingerprint of whatever was applied, subscribes
to the coarse invalidate, and re-applies when main reports a different fingerprint for the same
slug. That is deliberately not keyed to `written` paths — an undo, a pull and another window's
reset are exactly the writes no command in this session ran. Undoing a prose edit moves no
fingerprint and moves no panes.

Two details keep that from looping. The fingerprint is adopted **before** the re-apply, so one
moved file is one attempt whether or not it takes; and at boot `seed()` takes the fingerprint
without applying anything, because the window is the mesh the session remembered and re-applying
would throw away a border the author dragged last session.

## The merge policy

`.gitattributes` in the project, appended by `ensureLayouts` and never overwriting what an author
wrote — the second of the two rules this app puts there, beside the notification log's
`merge=union` ([`repos-and-commits.md`](../../repos-and-commits.md#the-gitattributes-a-project-gets)):

```gitattributes
# A view layout is one blob: which panes exist, how big they are, what each holds. Two
# authors' versions merged line by line make an arrangement neither of them built, so git is
# told not to try. Pick one:
#   git checkout --ours   .vnstudio/layouts/<name>.json    # keep mine
#   git checkout --theirs .vnstudio/layouts/<name>.json    # take theirs
#   git add               .vnstudio/layouts/<name>.json
.vnstudio/layouts/*.json text eol=lf -merge
```

`-merge` rather than a registered custom driver, because a driver needs
`git config merge.<driver>.driver` installed in every clone to work at all, and `initRepoAt` cannot
reach a collaborator's machine. `-merge` needs nothing: git refuses to auto-merge, leaves **ours**
in the worktree, and marks the path conflicted.

The app then has to notice. It asks git rather than guessing: `isConflictCode(x, y)` over
`git status` porcelain codes (`DD AU UD UA DU AA UU`) is what marks a layout unusable, and
`isConflicted(text)` — a `<<<<<<<`/`>>>>>>>` scan — catches the same state in a file handed over
some other way. A conflicted layout is **listed** with the reason and **refused by name** when
applied, naming the path and the two commands that resolve it. Applying half a mesh would be worse
than saying so.

This is checked against real git in `src/main/tests/layouts.test.ts`, end to end: two branches edit
`writing.json`, the merge fails, the worktree still holds exactly ours, the app refuses it — and
`git checkout --ours` followed by `git add` makes it readable again.

What the refusal deliberately does *not* catch is a byte-order mark. A template is a file an
author may open by hand, and on Windows both Notepad and PowerShell put one on what they write;
`JSON.parse` rejects it, so refusing over one would be refusing a layout that is otherwise
perfectly good. `parseLayoutFile` strips a leading BOM before parsing.

## Digest props in a form

`view.saveLayout`'s `layout` prop is 20-odd KB of serialized mesh. `prop.string(..., {digest: true})`
already kept that out of `commands.jsonl` (the record stores a digest), but the *form* still drew a
textbox over it: unreadable, and one keystroke from corrupting it.

So `digest` now reaches the renderer — `CatalogProp.digest` in `@vn/commands`, carried through
`toCatalog` — and `CommandForm` renders a filled digest prop as a summary line,
`21 KB — the arrangement, as the renderer serialized it`, via `bulkSize` in `renderer/rules/catalog.ts`.
`doc.write` in the palette gets the same treatment for the same reason.

## Files

**New**

- `apps/desktop/src/shared/layouts.ts` — the format: recipe types, the envelope, slugging,
  validation, conflict detection, the shipped recipes, the `.gitattributes` block. Node-free,
  because the renderer bundles it.
- `apps/desktop/src/main/layouts.ts` — the I/O: list, read, write, reset, ensure, and the git
  status codes that mean "conflicted".
- `apps/desktop/renderer/pathux/layouts.ts` — the window's side of a template: which one is
  showing, `currentLayoutFile`, `fetchLayouts`, and the fingerprint watch that follows the file.
- `apps/desktop/src/main/tests/layouts.test.ts`, `apps/desktop/src/shared/tests/layouts.test.ts`.
- `templates/basic/.gitattributes` — so a seeded workspace inherits the merge policy.

**Changed**

- `apps/desktop/renderer/pathux/editors/header.ts` — the two submenus, tooltips everywhere, the
  layout fetch, `saveLayout()`.
- `apps/desktop/src/main/commands/view.ts` — four commands, `view.layout` retitled.
- `apps/desktop/src/main/commands/index.ts` — registration.
- `apps/desktop/src/shared/ipc.ts` — the `view/apply` effect.
- `apps/desktop/renderer/pathux/view.ts` — the `apply` case.
- `apps/desktop/renderer/pathux/persist.ts` — `loadScreen` split out of `restoreLayout`, so the
  boot path and a saved template build the same way.
- `apps/desktop/renderer/pathux/shell.ts` — `applyLayout`, `buildScreen` from a recipe,
  `settleScreen` shared by every path onto a new screen, `buildDefaultScreen` building
  `DEFAULT_RECIPE`, and a multi-editor pane coming up on its **first** editor.
- `apps/desktop/renderer/pathux/context.ts` — `applyLayout` on `ShellApp`, so `applyView` can
  reach it.
- `apps/desktop/src/main/index.ts` — `ensureLayouts` on the real launch paths.
- `apps/desktop/src/main/workspace.ts` — the skeleton's layout files and `.gitattributes`,
  `ensureLayouts` before `ensureRepo`.
- `apps/desktop/src/main/session.ts` — `.vnstudio` on the document tree's skip list.
- `packages/commands/src/catalog.ts`, `apps/desktop/renderer/rules/catalog.ts`,
  `apps/desktop/renderer/pathux/commandform.ts` — `digest` in the catalog and in a form.

**Not changed** — the undo pathspec. `.vnstudio/` was already inside it.

## Verification

`pnpm check` (both passes), `pnpm test`, `pnpm lint`, plus the node tests above.

Live over CDP, against a real project: layouts listed with fingerprints; Art and Writing applied to
the right meshes; `pathux.template` survived a restart; the Save dialog's verdict flipped from
refusal to `✓ writes .vnstudio/layouts/draft.json` as a name was typed, and its `layout` prop drew
as `21 KB — the arrangement, as the renderer serialized it` rather than a textbox; Draft saved and
round-tripped a four-pane mesh no recipe describes; reset rewrote both shipped files, left
`draft.json` alone and re-applied; undo restored the file **and** the screen with no second act, and
redo reversed both; a conflicted file was listed with the pick-a-side sentence and refused by name.

## Deviations

- **Recipe/blob hybrid, not blob-only.** The plan chose the nstructjs blob for everything. That
  cannot be written by main, and main is what scaffolds a new project, ensures an old one and
  resets. Shipped layouts are therefore recipes; saved ones are blobs; the envelope carries either.
  The plan's reason for blobs — an arbitrary dragged mesh must round-trip — is preserved exactly,
  for the case that has a renderer in the loop.
- **`view.applyLayout` is not mutating.** The plan had `view.template` pushing an effect and left
  its mutability implicit; making it explicit, it writes nothing in the project.
- **Reset takes `scope`, not a pre-materialised `layouts` blob.** With recipes, main can rewrite
  the shipped files itself, so the renderer no longer has to build each built-in into the live
  screen and serialize it. The two frames of flicker the plan accepted do not happen.
- **No `.vnstudio/.gitkeep`.** The plan wanted one because the template files could not be part of
  the skeleton. With recipes they can be, so the skeleton writes the real files and they track the
  directory on their own.
- **`ensureLayouts` also runs at `app.whenReady()`**, not only in `openWorkspace`. The plan
  assumed opening a workspace was the one entry point; neither `--project` nor the recents branch
  goes through it, and those are the normal launch paths.
- **`digest` in the form** was not in the plan. It was found by looking at the Save dialog.
