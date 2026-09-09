# Every command declares what it touches

Adds an `affects` field to every mutating command definition, naming the subtrees the
command may write. Three things read it: a registry test that checks it is well-formed,
two rules that tie it to `undoable`, and an executed tier that runs the command over a
scratch project and fails when the snapshot diff reaches outside what was declared.

Status: **shipped** 2026-09-09, in six commits on `plan8-affects`. Plan 8 of the eight in
[`../ux-behaviour-model-tasklist.md`](../ux-behaviour-model-tasklist.md); depends on
nothing, and nothing depends on it. What was built and where it differs from the plan is
in [As shipped](#as-shipped).

Revised once, after a fresh-context pressure test that found four commands writing outside
the workspace, two undoable commands the first draft's central rule would have failed, and
an existing doc comment that already carries the plan's stated motivation. See
[Findings](#findings) for the disposition of each of the twenty-one results.

<!-- toc -->

- [Context](#context)
    - [What exists](#what-exists)
    - [What is undeclared today](#what-is-undeclared-today)
    - [The numbers](#the-numbers)
- [Decisions this plan settles](#decisions-this-plan-settles)
    - [`affects` is a list of path prefixes](#affects-is-a-list-of-path-prefixes)
    - [`ui.*` field names are not part of it](#ui-field-names-are-not-part-of-it)
    - [The vocabulary is closed, and it reaches outside the workspace](#the-vocabulary-is-closed-and-it-reaches-outside-the-workspace)
    - [The matching rule lives in the app, and `checkWrittenScope` is left alone](#the-matching-rule-lives-in-the-app-and-checkwrittenscope-is-left-alone)
    - [`affects` is an upper bound, never a lower one](#affects-is-an-upper-bound-never-a-lower-one)
    - [Two rules tie `affects` to `undoable`, and neither is an iff](#two-rules-tie-affects-to-undoable-and-neither-is-an-iff)
    - [A test enforces the declaration, not the type](#a-test-enforces-the-declaration-not-the-type)
    - [The executed tier skips two paths and nothing else](#the-executed-tier-skips-two-paths-and-nothing-else)
    - [The runnable subset is a fixture table that partitions the 94](#the-runnable-subset-is-a-fixture-table-that-partitions-the-94)
- [What changes](#what-changes)
    - [Stage 1 — the field, and the vocabulary module](#stage-1--the-field-and-the-vocabulary-module)
    - [Stage 2 — the 94 declarations, and the three registry tests](#stage-2--the-94-declarations-and-the-three-registry-tests)
    - [Stage 3 — the catalog and the generated tables](#stage-3--the-catalog-and-the-generated-tables)
    - [Stage 4 — `diffTrees`, and the executed harness](#stage-4--difftrees-and-the-executed-harness)
    - [Stage 5 — the fixture table and the partition](#stage-5--the-fixture-table-and-the-partition)
    - [Stage 6 — the docs, and three corrections](#stage-6--the-docs-and-three-corrections)
- [Testing](#testing)
- [Risks](#risks)
- [Follow-ups deliberately not in scope](#follow-ups-deliberately-not-in-scope)
- [As shipped](#as-shipped)
    - [Stage 1, as shipped](#stage-1-as-shipped)
    - [Stage 2, as shipped](#stage-2-as-shipped)
    - [Stage 3, as shipped](#stage-3-as-shipped)
    - [Stage 4, as shipped](#stage-4-as-shipped)
    - [Stage 5, as shipped](#stage-5-as-shipped)
    - [Stage 6, as shipped](#stage-6-as-shipped)
- [Findings](#findings)
    - [Accepted](#accepted)
    - [Rejected](#rejected)

<!-- tocstop -->

## Context

### What exists

- **A command definition declares its guard but not its effect.** `Command`
  (`packages/commands/src/command.ts:59`) carries `mutating`, `confirm?`, `undoable?`,
  `commitsItself?`, `defersCommit?` and `check?`. None of them says which files the
  command writes.
- **Undo already hashes the document tree.** `UndoJournal.capture`
  (`packages/commands/src/undo.ts:70`) walks the workspace into a content-addressed
  `ContentStore` and answers one tree hash. `CommandStack` brackets every
  `undoable && mutating` command with two of them (`stack.ts:268-283`).
- **`ContentStore.tree(hash)` returns the entries of one directory** (`content.ts:135`),
  which is what makes a path-level diff of two trees possible without touching disk.
- **A command reports what it wrote.** `CommandOutput.written` is a list of
  workspace-relative, forward-slashed paths. It is the command's own claim, not a
  measurement — `docs/reference/command-system.md:290` says so and contrasts it with
  `undo.changed`, which compares the two trees.
- **Checkpoints already assert a subtree, after the fact.**
  `beginCheckpoint(label, message, scope)` confines its snapshot to `scope`, and
  `checkWrittenScope` (`stack.ts:535`) warns when a command inside it reports a `written`
  path outside. The doc is explicit that this "sidesteps the general drift problem rather
  than solving it" (`command-system.md:319`).
- **A normalizer for these paths already exists.** `normalizePath`
  (`apps/desktop/src/shared/writes.ts:13`) strips backslashes and a leading `./` for
  exactly this class of input, and the renderer already imports it.
- **The registry loads without Electron on purpose.** `createDesktopRegistry()` reaches
  the session only through a type-only import, so the catalog generator and
  `apps/desktop/src/main/commands/tests/commands.test.ts` construct it in a plain Node
  process. That test is where the whole-registry rules already live.
- **`WorkspaceSession` is Electron-free and drivable over a real project.**
  `apps/desktop/src/main/tests/session.test.ts` builds one over a `@vn/testkit` project
  and calls it directly, which settles that testkit is reachable from a desktop test.

### What is undeclared today

- **No command says where it writes.** The closest thing is prose in `notes` —
  `gate.approve` says "Flips `character.md`; writes the approved PNG + manifest";
  `view.saveLayout` names `.vnstudio/layouts/<slug>.json`. Nothing checks any of it, and
  at least one such note is wrong (see
  [stage 6](#stage-6--the-docs-and-three-corrections)).
- **`undoable`'s reasons are written down once, in prose, in a test comment.**
  `commands.test.ts:163-185` is a twenty-line doc comment enumerating eight overlapping
  reason classes — generated output, new content-addressed bytes, a log append, worktree
  restructuring, a different tree, bytes from outside, `vngen/state`, a credential — and
  names the commands in each. It is a good comment and a bad index: it cannot be queried,
  it cannot fail, and a command added later joins no class. **This plan converts that
  comment into per-command data**, which is a smaller claim than the first draft made and
  a truer one.
- **Nothing drives the desktop registry through a real `CommandStack`.** The only
  `new CommandStack` outside the app is in `@vn/commands`'s own tests, over toy commands.
  There is no executed tier at all.
- **Four mutating commands write outside the workspace entirely.** `plugin.install`,
  `plugin.remove` and `plugin.prices` write under `userConfigDir()`
  (`packages/gengraph/src/pluginload.ts:19`, `pricestore.ts:25`), and `project.setKey`
  with `scope='user'` does too. No workspace-relative vocabulary can name those paths,
  which is why the vocabulary below carries a sentinel for them.

### The numbers

Measured from the committed `docs/reference/command-table.md` and the source, 2026-09-09.

- 170 commands in 22 namespaces. **94 are `mutating`**, 62 are `undoable`, 19 ask for
  confirmation, 107 declare a precondition.
- The 94 mutating, by namespace: `story` 27, `gengraph` 22, `prompt` 8, `asset` 7, `art`
  5, `workspace` 5, `agent` 3, `doc` 3, `plugin` 3, `project` 3, `pipeline` 2, `upload` 2,
  `view` 2, `gate` 1, `notify` 1.
- The 62 undoable sit in seven namespaces: `story` 25, `gengraph` 21, `prompt` 8, `doc` 3,
  `view` 2, `art` 2, `project` 1.
- 19 commands are `confirm: true`; all 19 are mutating, and six of them are in the
  namespaces the executed tier reaches: `gengraph.delete`, `gengraph.run`,
  `project.setArtStyle`, `project.installPages`, `story.decomposeAll`, `view.resetLayout`.
- `UNDO_EXCLUDES` (`apps/desktop/src/main/workspace/workspace.ts:47`) is five entries:
  `vngen/build`, `vngen/state`, `assets/objects`, `keys`, `.vnstudio/session.json`.
  `ContentStore.capture` additionally skips `.git`, `node_modules`, every extension in
  `MEDIA_EXTS` (`content.ts:45`), and atomic-write temp siblings.
- 22 call sites push a `UiEffect` through `ctx.host.ui(...)`, across 11 command files.

## Decisions this plan settles

The tasklist routes one open decision here: whether `affects` is a list of document-tree
path prefixes, a list of `ui.*` field names, or both, and how the snapshot diff is matched
against it. The first four sections answer it.

### `affects` is a list of path prefixes

```ts
/**
 * Subtrees this command may write, workspace-relative and forward-slashed. An upper bound: a
 * run that writes less is not a violation, and nothing checks that every prefix is reached.
 */
affects?: readonly string[];
```

- **Workspace-relative and forward-slashed**, the form `written`, `checkWrittenScope` and
  `DocNode.path` already use.
- **No trailing slash**, and no leading `./`. `'scenes'`, not `'scenes/'`. A malformed
  entry is refused rather than normalized, so two declarations of one subtree cannot
  differ textually.
- **A file is a legal prefix.** `project.setArtStyle` declares `'project.yaml'`.
- **The empty list is illegal** on a mutating command. A command that writes nothing is
  not mutating.

### `ui.*` field names are not part of it

`ui.*` is the renderer's selection state: seven `SelectionField`s on `ShellState`
(`apps/desktop/renderer/pathux/app/state.ts:10`) — `sceneId`, `shotId`, `characterId`,
`docPath`, `taskHash`, `assetHash`, `graphSlug`.

- **A command reaches three of the seven, indirectly.** The only route from main is a
  `view.open` / `view.focus` effect carrying `subject`, which the renderer routes through
  `SUBJECT_OF` (`apps/desktop/renderer/rules/route.ts:34`) to `docPath`, `assetHash` or
  `graphSlug` depending on the editor, and assigns in `withSubject`
  (`apps/desktop/renderer/pathux/panes/view.ts:77`). `sceneId`, `shotId`, `characterId`
  and `taskHash` are unreachable from a command at all.
- **No tier can measure the other three.** The executed tier has no renderer, so a `ui.*`
  list would be a declaration with no oracle. Plan 7 settled the same question the same
  way for `enabled` and the tooltip: a field no tier can check against another is worse
  than an absent field, because it reads as verified.
- **The observable thing is the effect, not the field.** What is genuinely undeclared is
  that `pipeline.run` opens the tasklist popup and `upload.pick` opens a conversation.
  That is a different field with a different oracle — a recording stub `host.ui` — and it
  is a follow-up rather than scope.

### The vocabulary is closed, and it reaches outside the workspace

Every declared prefix must be a known root, or under one. Without this a typo (`'scene'`
for `'scenes'`) declares a subtree nothing writes and every test still passes.

- **Directories:** `characters`, `locations`, `wiki`, `scenes`, `screenplay`, `assets`,
  `vngen`, `.vnstudio`, `.aiagent`, `.github`, `keys`.
- **Root files**, because commands write them and none is under a directory root:
  `project.yaml`, `screenplay.fountain` (`apps/desktop/src/main/session/pipeline.ts:54`),
  `AICONTEXT.generated.md` (`packages/authoring/src/generated.ts:14`), `.gitignore`,
  `.gitattributes`.
- **`keys` is a legal declaration, not a refusal.** `project.setKey` exists to write
  `keys/<vendor>.key`, and refusing the root would make the one command that touches it
  undeclarable. What the vocabulary does instead is make the declaration visible: `keys`
  is in `UNDO_EXCLUDES`, so declaring it forces `undoable: false` by the rules below —
  which is the property `project.setKey`'s own comment argues for at length. The executed
  tier never captures the directory
  ([below](#the-executed-tier-skips-two-paths-and-nothing-else)), so no credential reaches
  a snapshot.
- **`<user>` is a sentinel for the user-level config directory** (`userConfigDir()`,
  `packages/config/src/keys.ts:88`), which is outside every workspace and which no
  snapshot can ever cover. Four commands need it. It is spelled with angle brackets
  precisely because it can never collide with a real path, and any prefix under it is
  written `<user>/plugins`.

### The matching rule lives in the app, and `checkWrittenScope` is left alone

`covers(prefixes, path)` goes in the new `apps/desktop/src/shared/affects.ts`, beside the
project layout it is about, and normalizes its path argument with the existing
`normalizePath` from `shared/writes.ts` plus a trailing-slash strip. The test is
`checkWrittenScope`'s: `p === s || p.startsWith(s + '/')`.

- **The trailing-slash tolerance is load-bearing.** `story.decomposeAll` reports
  `written: ['vngen/work/shots/']` — a directory (`story.ts:833`).
- **`checkWrittenScope` (`stack.ts:535`) is not touched.** The first draft folded it onto
  `covers`, which would have changed behaviour for every checkpoint caller in a shared
  package in exchange for four saved lines. Unifying them is a follow-up, after `affects`
  has been right for a while.
- **`affects` therefore has no framework use.** `@vn/commands` carries and serializes the
  field; the desktop app interprets it. That is exactly the arrangement `mutating` and
  `undoable` already have.

### `affects` is an upper bound, never a lower one

- **A run that touches less than it declared passes.** `story.newShot` writes
  `vngen/work/shots/<scene>.json` only when there is something to write.
- **Nothing checks that a declared prefix is ever reached.** A lower bound needs a fixture
  per branch of every command, not per command.
- **An over-broad declaration passes every tier here.** For a few commands the breadth is
  forced rather than lazy: `doc.write` may legitimately write any document outside
  `scenes/**`, so its truthful `affects` is most of the vocabulary and carries little
  information. The closed vocabulary rules out the worst case (`.` is not a root); review
  handles the rest.

### Two rules tie `affects` to `undoable`, and neither is an iff

The first draft asserted an iff — a command is undoable exactly when every declared prefix
is inside the covered tree — and it is false in both directions. `view.saveLayout` and
`view.resetLayout` are undoable and both call `ctx.host.state.set(templateKeyFor(ctx), …)`
(`view.ts:233`, `:277`), a `pathux.` key that `SessionState` routes to
`.vnstudio/session.json`, the fifth entry of `UNDO_EXCLUDES`. What replaces it:

- **Rule A, no exemptions: `undoable: true` requires at least one declared prefix inside
  the covered tree.** A command whose every write is excluded has nothing for a snapshot
  to restore. This holds over the 62 today.
- **Rule B, with an exemption list: a mutating command that is not undoable must either
  declare no covered prefix at all, or appear in `NOT_UNDOABLE` with a one-sentence
  reason.**

`NOT_UNDOABLE` is expected to hold roughly eight to eleven entries, and every reason is
already written in `commands.test.ts:163-185`. The ones the source shows now:

- `story.screenplay` writes `screenplay.fountain` at the root — covered, but generated
  output.
- `workspace.reindex` writes `AICONTEXT.generated.md` — the same class.
- `asset.accept` and `asset.unapprove` write `assets/manifest.json` for a base-root asset.
- `gate.approve` writes `characters/<id>/character.md` alongside a PNG the store never
  holds.
- `workspace.open`, `workspace.create`, `workspace.pick` and `workspace.import` write into
  a different tree than the one a snapshot covers.
- `project.setKey` at project scope writes `keys/` and `.gitignore`.

The exemption list is the deliverable, not an escape hatch: it is the twenty-line comment
turned into data, keyed by id, and the test fails both on a command missing an entry and
on an entry no longer needed. A list of eight to eleven is what makes the two rules worth
having; a list of forty would mean the rules were the wrong shape.

### A test enforces the declaration, not the type

`affects` could be required-when-mutating by splitting `Command` into a union
discriminated on `mutating`. It is not: `defineFor<Host>()` infers `M` from the literal,
and a union would have to preserve that inference through both arms across 170
definitions. The registry test is already the enforcement mechanism for every other
whole-registry rule, and it reports the offending id, which a type error at 170 call sites
does not.

### The executed tier skips two paths and nothing else

The harness captures the workspace root with its own `ContentStore`, not the stack's
journal, so the diff covers all 94 mutating commands rather than only the 62 undoable
ones. It passes a `skip` set of exactly two entries, each for a stated reason:

- **`keys`** — `ContentStore.capture` would otherwise read a credential into an in-memory
  blob store. The repo's secrets convention says no, and `project.setKey` is in `SKIPS`
  anyway.
- **`.vnstudio/session.json`** — `SessionStore.set` schedules a debounced flush, so a
  write from command _N_ lands during command _N+1_'s window and would be reported against
  the wrong command. The cost is a blind spot: `view.saveLayout`'s session write is
  declared and lint- checked but never measured. Stated rather than solved.

`vngen/build` and `vngen/state` are **not** skipped, unlike `UNDO_EXCLUDES` — a command
writing generated output is exactly the case the tier needs to see.

**`written` is checked against `affects` as well as the diff**, because the two miss
different things. The diff misses media (`ContentStore.capture` skips it wherever it
sits), so a command writing only a PNG has an empty diff; `written` names it. `written`
misses whatever the command forgot to report; the diff finds it. A diff that is empty is
not a failure, per the upper-bound rule.

### The runnable subset is a fixture table that partitions the 94

Not every mutating command can run in a test: `agent.run` needs a model, `plugin.install`
needs the network, `upload.pick` needs a dialog, `workspace.open` replaces the workspace.

- **`RUNS` is a table from command id to props**, hand-written against the fixture
  project. Its natural reach is `story`, `gengraph`, `prompt`, `doc`, `view` and
  `project.setArtStyle` — 60 of the 62 undoable commands. The two it does not reach are
  `art.setNotes` and `art.setSeed`, which key off an asset hash.
- **`SKIPS` is a table from command id to a one-sentence reason.**
- **A test asserts the two partition the 94 mutating commands exactly**: no id in both, no
  id in neither, no id in either that is not a registered mutating command. A command
  added later cannot slip past by being in no table.
- The declaration lint and the two `undoable` rules still cover all 94. Only the executed
  tier is partial, and the partition test makes "partial" a written-down list.

## What changes

Six stages, each green on its own.

### Stage 1 — the field, and the vocabulary module

- `Command.affects?: readonly string[]` in `packages/commands/src/command.ts`, with the
  doc comment stating the upper-bound rule. Nothing in `@vn/commands` reads it.
- `apps/desktop/src/shared/affects.ts`: the vocabulary (directories, root files,
  `<user>`), `UNDO_EXCLUDES` moved in from `main/workspace/workspace.ts`,
  `snapshotted(prefix)` — true when the prefix is neither an exclusion nor nested inside
  one, and false for every `<user>` prefix — and `covers(prefixes, path)` over
  `normalizePath`.
- The move costs more than the first draft claimed: three source importers
  (`main/runtime/stack.ts`, `main/commands/tests/gengraph.test.ts`,
  `main/tests/workspace.test.ts`) and five documentation references (`command-system.md`
  ×2, `desktop-app-state.md`, `desktopAppState.md` ×2, `repos-and-commits.md`). It is
  still worth doing: `shared/` is what the renderer imports, and the predicate and the
  exclusion list must not be able to drift.
- Tests: `covers` against a trailing slash, a backslash, a leading `./`, an exact match,
  and a sibling sharing a textual prefix (`scenes2` is not covered by `scenes`);
  `snapshotted` against each of the five exclusions, a path nested inside one, and a
  `<user>` prefix.

### Stage 2 — the 94 declarations, and the three registry tests

The largest commit in the plan, and deliberately one: the declarations and the rules that
constrain them are one idea, and landing them apart would leave a stage where 94
unverified lists sit in the tree.

- `affects` on each of the 94 mutating commands, read off the session call each one makes
  rather than off its `notes`.
- In `commands.test.ts`:
    1. every `mutating: true` command declares a non-empty `affects`, every entry
       normalized and in the vocabulary; every `mutating: false` command declares none;
    2. rule A — every undoable command declares at least one covered prefix;
    3. rule B — every non-undoable mutating command declares no covered prefix, or is in
       `NOT_UNDOABLE` with a reason; an entry that is no longer needed fails.
- `NOT_UNDOABLE` is measured here, seeded from `commands.test.ts:163-185`, and that
  comment is rewritten to point at the table rather than repeat it.

### Stage 3 — the catalog and the generated tables

- `CatalogEntry.affects` and `DocCommandEntry.affects` in
  `packages/commands/src/catalog.ts`, both optional and both omitted when absent, so a
  consumer reading `commands.json` today is unaffected.
- `scripts/lib/command-table.mjs` renders the subtrees in the Notes column of
  `docs/reference/command-table.md` and `command-namespaces.md`; both regenerate and
  `scripts/check-command-table.mjs` keeps them honest.
- `commands.test.ts` already compares `catalogOf` to `catalog()`, so the round trip is
  covered by a test that exists.

### Stage 4 — `diffTrees`, and the executed harness

- `diffTrees(store, from, to): string[]` in `packages/commands/src/content.ts` — the paths
  whose blob hash differs between two trees, root-relative, forward-slashed, sorted. The
  read-only half of `restoreDir`'s walk. Tests: an added file, a removed file, a changed
  file, a path that changed kind, an untouched subtree contributing nothing.
- `apps/desktop/src/main/commands/tests/__fixtures__/affects.ts` — **`__fixtures__`, not a
  `.harness.ts`**, because `eslint.config.mjs:329-331` turns `boundaries/element-types`
  off for `**/*.test.ts` and `**/__fixtures__/**` and nowhere else, and the harness
  imports `@vn/testkit`.
- What the harness supplies, each because something needs it:
    - a `@vn/testkit` project, and a `WorkspaceSession(dir, true, deps)` —
      **`mock: true`**, so `story.decomposeAll`, `prompt.condense` and `gengraph.run`
      refuse a model call rather than attempt one;
    - `git: openGit(root)` on the context, because `gitState()` calls `git.isRepo()` on
      every exec (`stack.ts:896`);
    - `confirm: () => Promise.resolve(true)` on the context, because `exec` refuses
      outright when a `confirm: true` command has no gate (`stack.ts:179-186`) and six of
      the runnable commands are `confirm: true`;
    - a `CommandHost` stub over all sixteen members (`commands/host.ts:44-117`): `ui`
      records what it is handed, `focusedWindow()` answers 0 because `view.saveLayout` and
      `view.resetLayout` call it, `state` is a real `SessionAccess` over the temp project,
      and every dialog and window member throws naming itself;
    - a `CommandStack` with no journal and no committer, so nothing writes `.git` or
      `commands.jsonl`.
- `exec` is wrapped so each call captures the root before and after into the harness's own
  store, with the two-entry skip set.
- One command end to end as proof: **`gengraph.setProp`**, whose reach is exactly one file
  under `vngen/work/graphs/`. Asserting both that the diff is covered and that a
  deliberately narrowed `affects` fails. `doc.write` would prove nothing — its truthful
  declaration is most of the vocabulary.

### Stage 5 — the fixture table and the partition

- `RUNS` and `SKIPS` in `affects.test.ts`, and the partition test over the registry.
- Two fixture projects, because they cost differently:
    - a scaffolded `makeProject()` for `story`, `doc`, `gengraph`, `view` and
      `project.setArtStyle`;
    - one that has additionally run the mock pipeline, for the eight `prompt.*` commands,
      which key off an asset hash from the manifest. This is the dominant cost in the
      suite and the reason `art.setNotes` and `art.setSeed` stay in `SKIPS` rather than
      joining them.
- For each id in `RUNS`: run it, and assert every path in the diff and every path in
  `written` is covered by `affects`.
- Commands run in a fixed order within a namespace, because several depend on what the one
  before wrote.
- A failure names the command, the uncovered path, and the declared list.

### Stage 6 — the docs, and three corrections

- `docs/reference/command-system.md`: a section for `affects` — what it means, that it is
  an upper bound, the two `undoable` rules, and what the executed tier does and does not
  reach.
- `docs/reference/repos-and-commits.md`: the sentence about checkpoint `scope` being
  asserted rather than derived gains a pointer to `affects`.
- Three corrections the review turned up, each one line:
    - `project.installPages`'s note says it writes "`.github/` and `.vnstudio/`, outside
      the tree the undo snapshot covers". Only `.vnstudio/session.json` is excluded; the
      command is non-undoable because it also writes `vngen/build/story.play.json`.
    - `asset.accept` reports `written: ['manifest.json']` (`asset.ts:89`) — a path no
      project has. Stage 5 turns it into a failure, so it is fixed here or in stage 2,
      whichever comes first.
    - `commands.test.ts:163-185` is reduced to a pointer at `NOT_UNDOABLE`.
- `CLAUDE.md`'s command-system bullets gain the one-line rule.
- The tasklist's row 8, its checkbox and its open decision; the index row.

## Testing

- **`pnpm check`, `pnpm test`, `pnpm lint` green at every stage.**
- **The declaration lint and the two `undoable` rules run over all 94** and need no
  fixture, so they are the tiers that cannot rot.
- **The executed tier builds two fixture projects in `beforeAll`**, one of them by running
  the mock pipeline. Per-command projects would make this the slowest test in the repo.
- **Three deliberate-failure tests** prove the tiers can fail: a narrowed `affects` in
  stage 4, an unneeded `NOT_UNDOABLE` entry and an out-of-vocabulary prefix in stage 2.
- **No new generated artifact.** `command-table.md` and `command-namespaces.md` are
  already generated and already checked; this adds to them.

## Risks

- **Medium: the fixture table is the real cost, and it can rot.** Roughly 60 hand-written
  prop sets against two fixture projects. Contained by the partition test, which turns rot
  into a named failure rather than silent shrinkage.
- **Medium: `NOT_UNDOABLE` could come back larger than expected.** The eight to eleven
  entries above are read off the source and off the existing comment, but stage 2 is the
  first time every command's writes are traced. If the list passes roughly fifteen, rule B
  is describing an exception rather than a rule, and the honest response is to drop rule B
  and keep rule A, which needs no list at all. That is the stopping point, and it costs
  one commit.
- **Medium: an over-broad declaration passes every tier.** Discussed above; the closed
  vocabulary stops the worst of it, and declaring an excluded subtree that a command does
  not write forces `undoable: false` and fails rule A.
- **Low: 94 declarations in one commit.** The ~34 that never run are covered only by the
  lint and the two rules, so a wrong subtree there is caught by review or not at all.
- **Low: the stub host diverges from the real one.** Sixteen members; a command reaching
  one the stub answers differently would pass here and fail in the app. Contained by
  making every unimplemented member throw with its own name.
- **Low: `written` is not always a file path**, and at least one value is simply wrong
  (`asset.accept`). Handled by the trailing-slash tolerance and by stage 6.

## Follow-ups deliberately not in scope

- **`checkWrittenScope` folds onto `covers`.** One rule instead of two, but it changes
  behaviour in a shared package for every checkpoint caller. After `affects` has settled.
- **A checkpoint derives its `scope` from `affects`.** The scope of a run becomes
  computable, and the warning can become a refusal.
- **A command declares the `UiEffect` it pushes.** Verifiable with a recording stub host,
  and genuinely undeclared today, but a second field with a second oracle.
- **`affects` narrows what the agent may reach.** A policy change on top of a vocabulary;
  the vocabulary comes first.
- **A lower bound.** Asserting every declared prefix is reached needs a fixture per
  branch.

## As shipped

Six commits, each green under `pnpm check`, `pnpm test` and `pnpm lint` on its own.

### Stage 1, as shipped

**Done.** `Command.affects` in `packages/commands/src/command.ts`, and
`apps/desktop/src/shared/affects.ts` holding the vocabulary, the moved `UNDO_EXCLUDES`,
`snapshotted`, `covers` and `declarable`.

- As shipped: the move cost less than the plan stated. Three source importers were
  repointed, as predicted, but none of the five documentation references cites the
  constant's module — each names `UNDO_EXCLUDES` alone — so no doc needed an edit.
- As shipped: `declarable(prefix)` was added beside `covers` and `snapshotted`. The plan
  described the vocabulary check in prose and left it to the registry test; a predicate
  keeps the refusal of a malformed entry beside the list it is refused against.

### Stage 2, as shipped

**Done**, with one deliberate departure.

- **Rule B was dropped, at the plan's own stopping point.** `NOT_UNDOABLE` measured at 25
  entries against a predicted eight to eleven and a stated ceiling of fifteen. The cause
  is structural rather than a mis-measurement: `assets/manifest.json` is inside the
  document class while `assets/objects` is in `UNDO_EXCLUDES`, so every command that
  touches a base asset — `art.generate`, `art.promote`, `art.redraw`, all seven `asset.*`
  mutators, `gate.approve`, `pipeline.run` and `pipeline.approveAndRun` — writes a
  snapshotted path and is not undoable. Adding the eleven the plan already named, plus
  `agent.run`, `upload.files`/`upload.pick`, the four `workspace.*` writers and
  `project.installPages`, gives 25 of the 32 non-undoable mutators. Rule A is kept and
  needs no list.
- The three registry tests became three of a different shape: the declaration lint, rule
  A, and one that runs both predicates over synthetic commands so each is shown to fail.
- **`archive` joined the vocabulary.** The plan's list omitted it; `upload.files` and
  `upload.pick` copy the author's documents into `archive/`
  (`packages/authoring/src/archive.ts`).
- **`ANY_DOCUMENT` and `ANY_UNGUARDED_DOCUMENT`** name the forced-breadth case the plan
  describes under the upper-bound rule. `doc.write` and `doc.rename` take the second,
  since both refuse `scenes/**`; `agent.run` takes the first.
- **Two wrong `written` claims were corrected here rather than in stage 6**, because the
  declaration beside each would otherwise have had to match a path no project has.
  `AssetStore.manifestFileOf(hash)` answers the manifest of the root holding a hash — the
  same base-first routing `accept` and `unaccept` use — and `asset.accept` and
  `asset.unapprove` report that instead of a hardcoded path. `asset.unapprove`'s portrait
  branch also reports the character sheet where it was discovered rather than assuming
  `characters/<id>/character.md`.

### Stage 3, as shipped

**Done.** `CatalogEntry.affects` and `DocCommandEntry.affects`, both optional and both
omitted when absent; `scripts/lib/command-table.mjs` opens a mutator's Notes cell with the
subtrees it declared.

### Stage 4, as shipped

**Done**, as described, including the `gengraph.setProp` proof and its
narrowed-declaration counterpart.

- As shipped: the harness opens the install-global `SessionStore` in a temp directory
  outside the workspace. Opening it at the project root — the obvious reading of "a real
  `SessionAccess` over the temp project" — writes `<root>/session.json` eagerly, which
  lands in the diff of whichever command happens to be running.
- As shipped: `RunResult` carries `data`, so a fixture can name the node or slug the
  command before it created.

### Stage 5, as shipped

**Done.** `RUNS` holds 59 commands and `SKIPS` 35, and they partition the 94 exactly.

- **The runnable reach is 59, not 60.** The plan predicted 60 of the 62 undoable commands.
  Four it assumed runnable are in `SKIPS`: `gengraph.run` declares no mock flag, so it
  reaches real providers; `prompt.condense` asks a real text model; `prompt.repin` moves a
  reference the derived prompt pinned to a slot, and the mock fixture draws none;
  `view.saveLayout` takes an arrangement only a live renderer can serialize. Against that,
  `RUNS` also reaches `story.export`, `story.screenplay` and `workspace.reindex`, which
  are not undoable at all.
- As shipped: the scaffolded project is built with an outfit on `aiko` and a second
  variant on `classroom`, so `story.setOutfit`, `story.setSceneOutfit` and
  `story.setVariant` have something to name that the project's own sheets declare.
- As shipped: a `Run`'s props may be a function of the harness, so a line id, a shot id or
  a node id is read back from the session rather than hardcoded against a fixture that the
  commands before it have already edited.

### Stage 6, as shipped

**Done.** A section in `command-system.md`, the pointer from `repos-and-commits.md`, the
`CLAUDE.md` bullet, and the tasklist and index rows.

- **`project.installPages`'s note is corrected**, as the plan asked: `.github/` and
  `.vnstudio/pages/` are both inside the snapshot, and what puts the command outside undo
  is the `vngen/build/story.play.json` it exports in the same act.
- **`asset.accept`'s `written` was corrected in stage 2.** The plan's claim that stage 5
  would turn it into a failure is wrong: every `asset.*` mutator is in `SKIPS`, so no tier
  reads that path. It was fixed because it was wrong, not because a test caught it.
- **A fourth correction the plan did not name.** `gate.approve` reported
  `vngen/build/manifest.json` and `characters/<id>/character.md`. A portrait is a base
  kind, so the manifest is `assets/manifest.json`, and the sheet is wherever the `type:`
  tag was discovered. Both now come from `approveCharacter`.
- **The comment at `commands.test.ts:163-185` is left standing.** The plan reduced it to a
  pointer at `NOT_UNDOABLE`; with rule B dropped there is no table to point at, and the
  comment is again the only place the reasons are written down.

## Findings

From a fresh-context pressure test of the first draft, 2026-09-09. Four were blocking,
thirteen substantive, four minor. Every claim below was re-verified against the source
before being folded in.

### Accepted

1. **Four mutating commands write outside the workspace, and the vocabulary could not name
   them.** `plugin.install`/`remove`/`prices` and `project.setKey` at user scope write
   under `userConfigDir()`. Fixed: the `<user>` sentinel.
   [The vocabulary](#the-vocabulary-is-closed-and-it-reaches-outside-the-workspace).
2. **`project.setKey` writes `keys/`, which the draft refused outright**, making its three
   rules jointly unsatisfiable for one command. Fixed: `keys` is a legal declaration whose
   consequence is `undoable: false`. Same section. `.gitignore` joined the root files with
   it.
3. **The `undoable` iff is false in the undoable direction.** `view.saveLayout` and
   `view.resetLayout` are undoable and write `.vnstudio/session.json` through
   `host.state.set(templateKeyFor(ctx), …)`. Fixed: the iff became rules A and B, neither
   of which they violate.
   [Two rules](#two-rules-tie-affects-to-undoable-and-neither-is-an-iff).
4. **A harness named `*.harness.ts` cannot import `@vn/testkit`.**
   `boundaries/element-types` is off only for `**/*.test.ts` and `**/__fixtures__/**`.
   Fixed: the harness moved to `tests/__fixtures__/affects.ts`.
5. **`NOT_UNDOABLE` needs eight to eleven entries across four reason classes, not two.**
   `story.screenplay`, `workspace.reindex`, `asset.accept`/`unapprove`,
   `workspace.import`/`pick` and `project.setKey` were all missing. Fixed: the list is
   enumerated, and a stopping point was added to the risks for the case where it comes
   back much larger.
6. **The draft's stated motivation was wrong: the reasons are already written down**, in
   `commands.test.ts:163-185`. Fixed: the claim is now that the comment cannot be queried
   and cannot fail, and this plan turns it into data.
   [What is undeclared today](#what-is-undeclared-today).
7. **`story.play` is `mutating: false`.** It builds the playable in memory; `story.export`
   writes `vngen/build/story.play.json`. Fixed at both citations.
8. **`gate.approve` needs no media exemption** — it writes `vngen/build/manifest.json`, so
   the ordinary rule covers it. Fixed: the flagship example became `story.screenplay`, and
   the "writes media" category was dropped as a category.
9. **Three `ui.*` fields are reachable, not one.** `SUBJECT_OF` maps `subject` to
   `docPath`, `assetHash` or `graphSlug` by editor. The conclusion survives — four of
   seven are unreachable and no tier can measure any of them — but the evidence was wrong
   and is corrected.
10. **The vocabulary omitted every root-level file commands write.**
    `screenplay.fountain`, `AICONTEXT.generated.md`, `.gitignore`, `.gitattributes`.
    Fixed.
11. **The harness would have read `keys/` into memory**, since `ContentStore.capture`
    skips only `.git`, `node_modules`, media and temp siblings. Fixed: a two-entry skip
    set.
12. **A debounced session flush would be attributed to the wrong command.**
    `SessionStore.set` schedules rather than writes. Fixed: `.vnstudio/session.json` is
    the second skip entry, and the resulting blind spot is stated.
13. **Stage 4 did not supply what `CommandStack` needs**: `git` on the context, `confirm`
    on the context rather than the host (six runnable commands are `confirm: true`),
    `focusedWindow()` for the two `view.*` commands, and `mock: true` on the session.
    Fixed: all four are enumerated in the stage.
14. **`prompt.*` needs a pipeline run, not just `makeProject`.** Fixed: two fixture
    projects, and the cost is named as the dominant one.
15. **The runnable reach is 60 of 62, not 62 of 62, across seven namespaces, not six.**
    `art.setNotes` and `art.setSeed` are undoable and outside it. Fixed.
16. **`doc.write` is the weakest possible stage-4 proof**, because its truthful
    declaration is most of the vocabulary. Fixed: `gengraph.setProp`, and the
    forced-breadth limitation is stated under the upper-bound rule.
17. **`CommandHost` has sixteen members, not fourteen.** Fixed.
18. **`covers` would have duplicated `normalizePath`** (`shared/writes.ts:13`). Fixed by
    putting `covers` in `shared/affects.ts` beside it rather than in `@vn/commands` —
    which also removed the change to `checkWrittenScope`.
19. **The `UNDO_EXCLUDES` move is not three lines**: three source importers and five doc
    references. Fixed: the true cost is stated in stage 1, and the move is kept.
20. **`project.installPages`'s note is wrong**, and `asset.accept` reports a path no
    project has. Both were cited as correct. Fixed: they are corrections in stage 6.
21. **Four cited line numbers were off** (`SECRETS_REFUSAL`, `SelectionField`, the undo
    bracket, `state.ts`). Fixed.

### Rejected

- **"`@vn/testkit` is not a dependency of `apps/desktop`, and `CLAUDE.md` says nothing may
  import it."** Raised as part of the blocking harness finding. The file-naming half is
  right and is fixed; this half is not. `apps/desktop/src/main/tests/session.test.ts`
  already imports `makeProject` and `SCRIPTS`, resolving through the root tsconfig
  `paths`, and the rule the package's own doc comment states is that a test file is the
  only place it belongs. A fixture under `tests/__fixtures__/` is that place.
