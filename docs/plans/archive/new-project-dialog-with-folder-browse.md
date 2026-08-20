# The New Project dialog: browse for a folder, name the project, make the folder

Status: **shipped**

## Context

The author's report:

> The new project command should pop up a dialog with a button that pops up a file dialog the
> user can browse for a folder with. along with the title textbox. there should be a checkbox
> to create a new folder, if checked a new folder will be created using the title.

Today **New Project…** opens the palette on `workspace.create`, whose form is two textboxes:
`path` and `title`. The path has to be **typed**, and it has to name a directory that does not
exist yet — which is exactly the thing an OS chooser cannot express, and exactly why
[`new-and-open-project.md`](new-and-open-project.md) decided against a `workspace.createPick`:

> A `workspace.createPick` is **not** added: the OS dialog for "choose a parent and type a name"
> is a save-dialog, which is a different Electron API and a different set of platform behaviours.

That reasoning is sound about save-dialogs and wrong about the conclusion. The author is not
asking for a save-dialog. They are asking for the two halves to be **separate controls in one
form**: browse for a folder that _does_ exist, and let a checkbox decide whether the project
lands in that folder or in a new child of it named from the title. Both halves are then things
the OS chooser and a textbox can each say on their own.

**This plan reverses that decision**, and the paragraph above is replaced in the earlier plan.

## Decisions this plan settles

- **The palette form _is_ the dialog.** No second overlay. The app has exactly one place where a
  command states what it is about to do, shows its verdict and takes its arguments, and a bespoke
  New Project window would be a second one to keep in sync — with its own focus rules, its own
  Escape handling and its own idea of what `workspace.create` refuses.

  > **Superseded** by
  > [`new-project-as-its-own-dialog-and-its-own-repo.md`](new-project-as-its-own-dialog-and-its-own-repo.md).
  > The author's objection was the search box and the list of every other command, not the form —
  > so the form was extracted to `commandform.ts` and given a second host, `dialog.ts`. The fear
  > this decision was guarding against still holds and is still met: there is exactly one form,
  > hosted twice.

- **A path prop is a declared kind, not a naming convention.** `@vn/commands` gains
  `PropKind: 'directory'`, built by `prop.directory(description)`. It coerces exactly as a
  string — it _is_ a string — and its whole reason to exist is that the form knows the OS can
  fill it in. The alternative, a palette that renders a Browse button for any prop happening to
  be called `path`, makes the widget depend on spelling.

- **Browsing is a command, not an IPC channel.** `workspace.chooseDirectory` — non-mutating, no
  props, returns the chosen absolute path in `data` and `Cancelled.` when there isn't one. The
  Browse button `exec`s it like everything else, so CDP and the agent can reach the same act and
  the chooser shows up in the catalog rather than being a renderer-only capability.

  It lives in the `workspace` namespace because the only directory this app asks the OS about is
  a project's. If a second, non-project directory prop ever appears, the command moves — it does
  not get a duplicate.

- **`newFolder` defaults to `false`, and the menu entry checks it.** The switch is a prop on
  `workspace.create`, so the DSL can say it: `workspace.create(path='…' title='…' newFolder=true)`.
  But `workspace.create(path='/x/y')` already means "create the project **at** `/x/y`", and every
  existing caller, test and doc says so — flipping the default would silently redirect them all
  into `/x/y/<title>`. So the command keeps its meaning and **New Project…** opens the palette
  with `newFolder: true` overridden in, the same mechanism **Run Pipeline…** already uses to seed
  `mock`. The author gets the checked box; the vocabulary keeps its promise.

- **The folder is named by `slug(title)`, and the verdict names the result.** `@vn/model`'s
  `slug` is already this repo's answer to "a filesystem-safe name from prose", so "My First
  Story" becomes `my_first_story`. The important half is that `wouldCreate` resolves the **full**
  root and puts it in its sentence — the author reads where the project will actually land while
  they type the title, rather than trusting a rule.

- **A boolean prop renders as a checkbox.** The palette draws booleans as a yes/no button today,
  with a comment defending it ("the label carries the state"). path.ux's `check-x` carries a
  label of its own _and_ a tick, so it loses nothing, and the author asked for a checkbox by
  name.

- **`newFolder` with no title is a refusal, not a fallback.** A blank title is why `path`
  currently falls back to `basename(root)`; with the box checked there is no root yet to take a
  basename from, so the honest answer is to say the title names the folder.

## Stage 1 — `prop.directory` in `@vn/commands`

`packages/commands/src/props.ts`:

- `PropKind` gains `'directory'`.
- `coerceOne` handles it in the same arm as `'string'` and `'enum'`.
- `PropBuilders` gains `directory(description)` / `directory(description, {default})`, both
  returning `Prop<string, …>`.

`catalog.ts` needs nothing: `placeholder` and `jsonType` both fall through to the string case,
which is the right answer for a path in both `usage` and the JSON Schema.

`apps/desktop/renderer/rules/catalog.ts` needs nothing either — `blankValue` and `fieldValue`
already treat an unrecognised kind as a string, which is what a directory is.

Tests: `packages/commands/src/tests/props.test.ts` gains a case that `prop.directory` coerces a
string through and a number to its text, and that it lands in the catalog as `type: 'string'`.

## Stage 2 — `workspace.chooseDirectory` and the create semantics

`apps/desktop/src/main/commands/host.ts` — `pickDirectory` takes the options `pickFiles`
already does, so a chooser opened to pick a _parent_ does not say "Open project" on its button:

```ts
pickDirectory(options?: { title?: string; buttonLabel?: string }): Promise<string | undefined>;
```

`apps/desktop/src/main/index.ts` passes them through to `dialog.showOpenDialog`, keeping the
current wording as the default so `workspace.pick` is unchanged.

`apps/desktop/src/main/workspace.ts` — one pure helper beside `inspectCreate`, so the rule has a
test that does not need a window:

```ts
/** Where a create lands: the folder chosen, or a `slug(title)` child of it. */
export function createRoot(path: string, title: string, newFolder: boolean): string;
```

`apps/desktop/src/main/commands/workspace.ts`:

```
workspace.create(path='…' title='…' newFolder=false)
workspace.chooseDirectory()
```

`wouldCreate` gains the two new arguments, resolves through `createRoot`, and refuses:

- `path` blank — _"Choose a folder for the new project."_
- `newFolder` with a title that slugs to nothing — _"Type a title: it names the folder that will
  be created."_
- everything it already refuses, now stated against the resolved root.

`workspace.chooseDirectory` is `mutating: false`, `props: {}`, and returns
`{ message: 'Chose <path>.' | 'Cancelled.', data: { path } }`.

Tests: `apps/desktop/src/main/tests/workspace.test.ts` gains `createRoot` cases (unchecked
returns the folder; checked appends the slug; a title with punctuation and spaces slugs).

## Stage 3 — the palette

`apps/desktop/renderer/pathux/palette.ts`, in `field()`:

- `kind === 'directory'` — the same textbox as a string, plus a `Browse…` button in the row that
  `exec`s `workspace.chooseDirectory` and, on a path, writes it into the field and rechecks.
  The field is still typeable: the chooser is a convenience, not a gate.
- `kind === 'boolean'` — `row.check(undefined, label)` with `checked` seeded from the value and
  `on_change` writing it back and rechecking. Unlike the yes/no button this does **not** rebuild
  the form, so the checkbox keeps its own focus.

`apps/desktop/renderer/pathux/editors/header.ts`:

```ts
['New Project…', () => openPalette('workspace.create', { newFolder: true }), undefined],
```

with the comment rewritten — the palette is no longer the fallback for a path nothing can
choose, it is the form the browse button lives in.

## Stage 4 — documentation

- [`new-and-open-project.md`](new-and-open-project.md): the "A `workspace.createPick` is **not**
  added" paragraph is replaced with a pointer here, and a `Shipped deviations` line records the
  reversal.
- [`../../reference/desktop-app.md`](../../reference/desktop-app.md): the New Project… sentence.
- [`command-system.md`](command-system.md): the prop kinds list gains `directory`, and the
  palette section gains the Browse button and the checkbox.
- `CLAUDE.md`: the workspace-creation bullet gains the dialog's shape.
- `docs/plans/index.md`: a row for this plan.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- **New Project…** opens a form with a `path` field and a **Browse…** button, a `title` field,
  and a **newFolder** checkbox that starts checked.
- Browse opens the OS folder chooser and fills the field; cancelling changes nothing.
- With the box checked, the verdict names `<chosen>/<slug(title)>` and creating puts the project
  there.
- With it unchecked, the verdict names `<chosen>` and the old refusals (non-empty, is-a-file,
  inside-a-repo warning) all still fire against it.
- Checking the box with an empty title refuses by saying the title names the folder.
- `workspace.create(path='…')` from CDP behaves exactly as before this plan.

All of it was verified live over CDP against the running app. Driving the real menu — a synthesized
pointer sequence on the **VN STUDIO** dropbox, then the **New Project…** row — built a form holding
exactly `path` + **Browse…**, `title`, and a `newFolder` checkbox already ticked, sitting under
_"✕ Choose a folder for the new project."_ Clicking **Browse…** opened the OS chooser titled
_"Choose a folder"_; answering it with a folder wrote that folder into the `path` field and moved
the verdict on to _"✕ Type a title: it names the folder that will be created."_ Typing `My First
Story` turned it into _"✓ Creates a new project at …\vn-browse-probe\my_first_story: a starter
scene, a story bible page, project.yaml and a git repo."_, and unticking the box re-answered with
_"…at …\vn-browse-probe: …"_ — both textboxes keeping the text they held, which is the checkbox not
rebuilding the form. Cancelling the chooser answers `Cancelled.` and leaves the field alone.

## Shipped deviations

- **`prop.directory` is documented as a kind that says who can fill it in**, not merely as a
  string alias. The plan described the coercion; the doc comment that shipped has to say the other
  half out loud, because a kind that coerces identically to `string` otherwise reads as noise.
- **`workspace.chooseDirectory` dresses the chooser itself.** The plan gave `pickDirectory` the
  options and left the wording to the caller. The default wording stayed with `workspace.pick`
  ("Open project"), so the new command has to pass _"Choose a folder"_ / _"Choose folder"_ — a
  chooser that says **Open project** while filling in a field would be lying about what the click
  does.
- **The `directory` field's Browse button carries a `description`.** Every other palette widget
  gets its tooltip from the prop; this one is not the prop, so it needs its own sentence.
- **No `catalog.ts` change was needed, as predicted** — `usage` and the JSON Schema both fall
  through to the string case — but the generated `apps/desktop/dist/commands.json` still had to be
  regenerated, because `workspace.create`'s `usage` grew `newFolder=false` and a test compares the
  catalog to the live registry.
