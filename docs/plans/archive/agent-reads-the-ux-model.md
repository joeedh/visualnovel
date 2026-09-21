# The agent reads the UX model

Status: shipped 2026-09-21. Index row in [`../index.md`](../index.md). Reviewed once by a
fresh-context agent; the findings and what changed are in
[Review findings](#review-findings), and what landed and where it differs from the text
above is in [As shipped](#as-shipped).

## Problem

- `show_me` (`apps/desktop/src/main/agent/showme.ts`) lets the agent write a guided tour,
  and its description tells the model to use "the command ids and props in the command
  catalog" and "the gesture ids `interaction.list` names". Nothing hands the model either
  list. It writes ids from memory, and `checkTour` rejects the ones that do not exist.
- The two files that answer the model's real questions — which pane draws a command, which
  props the control already knows, when it is refused and what the refusal says, whether
  it has a control at all or only the palette — are read by nothing on the agent's side:
    - `apps/desktop/ux-model.json`: 1.15 MB, 1589 records, 164 situations, 125 distinct
      first-action ids (commands and the effects that reach the model, together). It is
      stored as situation × control, and the model's questions are keyed by command.
    - `apps/desktop/anchors.json`: 185 KB, a sweep of one sample project. What it adds per
      command is one bit: drawn somewhere in that sweep (`anchored`, 96 ids) or not.
- Both files reach an installer today only as part of the debug agent's `source/` snapshot
  (`packages/agentreport/src/sourcemap.ts` reads `apps/**/*.json`), which the authoring
  agent cannot see. Nothing reads either at runtime.
- `docs/research/ux-behaviour-model.md` (§"The readers already exist") and
  `docs/plans/ux-behaviour-model-tasklist.md` (line 388: "`show_me` and the debug agent
  can read it") both name the agent as a reader of the derived model.
  `docs/research/agent-access-to-the-ux-command-system.md` (Position B) proposes a
  read-only bridge: `command.check`, `interaction.targets`, the catalog. This plan builds
  the reader and the `check` half of the bridge.

## Decision

Two additions, and one thing deliberately not built.

1. **A generated page tree, keyed by command, that the agent lists, greps and reads.**
   Rendered at build time from `ux-model.json`, `anchors.json` and the registry into
   `apps/desktop/dist/ux/`, which ships inside the asar with the rest of `dist/`. Three
   read-only tools serve it: `ux_list`, `ux_read`, `ux_search`.
2. **A live precondition check.** `ux_check(command, props)` returns the verdict of
   `stack.check` for the open project. The pages say when a command is refused in a
   fixture; the check says whether it is refused now.
3. **No query language.** Every question the pages are for — by command, by editor, by
   situation, by the text of a tooltip or a refusal — takes one `ux_read` or one
   `ux_search`, which is how the model already uses `read_file` and `search`. A bespoke
   query grammar has to be learned from a tool description, gets misspelled, and answers
   nothing the tree does not. A static query also cannot say whether a command is refused
   in the open project right now; `ux_check` answers that.

### Why re-key rather than serve the JSON

- Folding the 1589 records by (first action, editor, module, label, tooltip, props,
  verdict) gives 678 rows across 125 ids — about five per id; the widest (`doc.write`)
  has 63. The bulk of the JSON is the same control repeated across situations that do not
  change it.
- There are 84 distinct refusal sentences (control `refusal.reason` plus menu `refused`)
  and one tooltip per control. Those sentences are what the agent should be putting in a
  step's `say`; today it invents them.

### Format of the pages: Markdown

Considered Markdown, YAML, JSON, JSON Lines.

- **Markdown, with one table row per fact.** Chosen. A page is read whole far more often
  than it is grepped, and a table is the cheapest reading of a row-shaped fact in tokens.
  A grep hit is one line carrying editor, module, situation, label and the sentence, and
  the file path carries the command. The prose (tooltips, refusals, the root `README.md`)
  is prose, and the model quotes a row into `say` without reformatting.
- **JSON Lines.** The strongest alternative: one line per fact with self-describing keys,
  where a Markdown hit's columns are positional. Rejected because the keys cost on every
  row of every page read whole, and a positional hit is resolved by one `ux_read` of the
  page, whose header names the columns. The README states the column order once.
- **YAML.** Rejected. A nested list puts the value on a different line from its key, so a
  grep hit needs context lines, and every sentence containing `: ` needs quoting.
- **Pretty-printed JSON, one file per command.** Rejected: worst for grep (a record spans
  lines) and for tokens.
- A `|` inside a sentence is escaped as `\|`. Nothing else in a cell needs escaping.

The renderer works from a typed intermediate (`UxDocs`, below) rather than from the JSON
directly, so the fold is tested structurally and the Markdown is tested with golden pages.
The intermediate is never written to disk.

### Layout

```
ux/
  README.md                    how to use this tree; the four step kinds; the column order;
                               "ids in sentences and `when` keys are a fixture's — take real
                               ids from the workspace index"; "an effect is not a command
                               and cannot be a step"
  commands/<ns>/<cmd>.md       one page per command id in the registry (192)
  effects/<id>.md              one page per effect (`shared/effects.ts`) the model records
  editors/<editor>.md          what an editor draws, grouped by module then situation (22)
  situations/<module>.md       every situation of a module, its `why`, which offers flip (31)
  interactions/<id>.md         from `interaction.list`: id, what is carried, the commands a
                               drop can run
  shortcuts.md                 the 36 shortcuts, one row each
```

A command page (rows illustrative):

```markdown
# story.setCoverage

<the command-table entry: title, description, notes, from `toDocIndex`>

Mutating · undoable · affects: `work/shots` · has a precondition (ask `ux_check`)

## Props

| Prop  | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| scene | string | yes      | …           |

## Drawn by

| Editor    | Module  | Situations | Label        | Tooltip              | Props known | Then |
| --------- | ------- | ---------- | ------------ | -------------------- | ----------- | ---- |
| documents | doctree | every-kind | Set coverage | Choose which shots … | scene=<row> |      |

## Refused when

| Editor   | Module   | Situation | Says                                          | More |
| -------- | -------- | --------- | --------------------------------------------- | ---- |
| coverage | shotgrid | no-shots  | sample has no shots yet — decompose it first. |      |

## Reached after

| Editor | Module | Situation | First runs |
| ------ | ------ | --------- | ---------- |

## Reaching it

- Control: drawn in the sweep of 2026-09-21 at 4d2e219. Palette-only rule: none.
- Shortcut: none.
- Menu: doctree on `scene:<row>`.
```

- The top of the page is the command-table entry `scripts/gen-command-table.mjs` already
  renders from `toDocIndex` (`packages/commands/src/catalog.ts`), because that is the one
  projection that carries `notes`, the doc-only prose the runtime catalog deliberately
  omits. The fold takes `DocCommandEntry` as its catalog input, not `CommandCatalog`.
- **Fold key is the first action.** `actionsOf` (`shared/uxmodel.ts`) gives a record's
  actions in order; 47 records carry more than one (`ui.publish` then `view.open`). The
  row lives on the first action's page with the rest in `Then`; each later action's page
  gets the same row under "Reached after", with `First runs` naming the first action. That
  is how a page answers "what happens before this command runs".
- "Props known" is the props the control records at draw time, spelled as the model spells
  them; a fixture id (`scene=sample`) is rendered as `scene=<row>`, and the README says
  why. `Situations` is a comma list: rows that differ only by situation fold into one.
- **Sentences are verbatim, fixture ids included.** A refusal such as "arrival:s1 has no
  frame yet — run the pipeline to draw one." names the fixture's shot. Substituting would
  need a table of fixture ids per situation, which nothing exports. The README says so,
  and the "Refused when" header on every page repeats it in one line. `More` is the
  refusal's longer `description`, where the rule gave one.
- "Reaching it" states the sweep's bit and the palette-only rule (`paletteMatches`,
  `shared/uxmodel.ts`) as two facts rather than one verdict, because they can disagree for
  a control that exists in a situation the sample project never reaches. Menu rows render
  `when` verbatim in the prefix form the model uses (`scene:<row>`, `header`, `view`); no
  hand-written prefix→prose table, which the UX-model batch made a non-goal.
- An effect page has the same tables and opens with one sentence: an effect is not a
  command; `checkTour` refuses a `command` step naming it; a tour reaches it by pointing
  at the control or shortcut in "Reaching it".
- A command with no records anywhere gets the props section and "Reaching it: not drawn in
  the sweep; palette-only rule: <rule or none>", which is the case a tour step routes to
  the palette for.

### The tools

Registered by the desktop session beside `show_me`, in
`apps/desktop/src/main/agent/uxdocs.ts`. All four are `mutating: false`, so plan mode
allows them, and all four are deferred like every tool outside the six `loop.ts` always
loads.

| Tool        | Args                        | Returns                                                                    |
| ----------- | --------------------------- | -------------------------------------------------------------------------- |
| `ux_list`   | `dir?`                      | entries under `ux/<dir>`, files and folders                                |
| `ux_read`   | `path`, `offset?`, `limit?` | the page, or a line range of it                                            |
| `ux_search` | `query`, `regex?`           | `path:line: text` hits; at most `UX_SEARCH_CAP` (200), then "… and N more" |
| `ux_check`  | `command`, `props?`         | `accept` / `refuse` / `undeclared` / `unjudged`, and the sentence          |

- `ux_read` resolves under the tree root and refuses a path that escapes it, in the same
  words `read_file` uses for a path outside the workspace.
- `ux_search` has a cap because `search` has none and the tree is 250 pages of table rows,
  where a common word returns hundreds of 150-character lines. The truncation line says to
  narrow the query.
- **`ux_check` fills the props it was not given.** `stack.check` coerces the full prop
  spec before any precondition runs, so a check with a required prop missing returns
  `invalid props … missing`, a refusal about the call rather than the project. The tour
  hit the same wall and answered it with `checkFor` (`renderer/rules/precheck.ts`), which
  passes an empty value for each missing required prop so the precondition is reached, and
  gives up on a prop with no empty value (a number, an enum) or a secret. `checkFor` moves
  to `shared/precheck.ts`, the renderer imports it from there, and `ux_check` uses it. A
  prop it cannot fill yields a fourth state, `unjudged`, whose sentence names the prop, so
  the model asks for the id rather than reading a refusal it cannot act on.
- `ux_check` needs the stack, which the session does not hold. `SessionDeps` gains
  `checkCommand?(id, props): Promise<{ state; message }>`, wired in
  `runtime/sessionaccess.ts` from `getStack(ctx).check(...)` the way `showTour` is wired
  from `ctx.broadcast`. Where the dep is absent the tool is not registered, so `vnauthor`
  never lists it.
- The first three take a root directory, resolved by `uxDocsDir()` in
  `distribution/resources.ts` as `join(__dirname, '..', 'ux')` — `__dirname` is
  `apps/desktop/dist/main` in a checkout and in the asar alike, and Electron's `fs` reads
  inside the asar from main. Where the directory is absent, the three are not registered
  and main logs one line naming the path it looked at, so a dev launch that skipped the
  generator says so rather than silently shipping an agent with no pages.
- `show_me`'s `DESCRIPTION` becomes `describeShowMe({ pages: boolean })`. With pages it
  says: "Before writing a step, `ux_read` `commands/<ns>/<cmd>.md`: it says which pane
  draws the control, which props the control already knows, and the sentence to use." The
  `interaction.list` reference becomes `interactions/`. Without pages it reads as today.
- Discovery is a chain, and the plan accepts it: `show_me` is itself deferred, so the
  model sees the pointer only after searching for `show_me`, then searches for `ux_read`,
  reads, and calls `show_me` — two round trips more than today per tour. Promoting
  `ux_read` into the always-loaded six would cost every authoring turn a schema for a
  question most turns never ask; the transcripts decide whether that trade is worth
  revisiting.

### Why separate tools rather than a virtual root under `read_file`

- `read_file` feeds `edit_file`'s read ledger (`tools/files.ts`), and every write tool
  would need to learn to refuse the virtual root. The tree is not in the workspace, so
  "outside the workspace" would have to grow an exception. Four small tools cost less than
  those exceptions, and the deferred catalog makes their schemas free until searched.

### Generation and shipping

- `scripts/gen-ux-docs.mjs`, run as `build:uxdocs` in `apps/desktop/package.json` after
  `build:catalog`, and once at the start of `scripts/dev.desktop.mjs`, so `pnpm dev` has a
  current tree at launch (a rules change during a dev session needs a relaunch, which is
  also true of `build:catalog`). It loads the model entry the way `gen-ux-model.mjs` does,
  the doc index the way `gen-command-table.mjs` does, reads `anchors.json`, folds,
  renders, and writes `apps/desktop/dist/ux/`.
- Not committed: `ux-model.json` is already the committed derivative with an equality
  test, and a second one of 250 files would churn on every rule change for no review
  value.
- `dist/**` is already in `electron-builder.yml`'s `files` and `package.desktop.mjs`
  copies all of `dist`, so the tree ships with no packaging change. It is inside the asar,
  which is why the root is `__dirname`-relative rather than an `extraResources` path.
  `smoke.ts` gains one check beside the builtin-skills one: `uxDocsDir()` exists and
  `README.md` reads.
- Tests never read `dist/`. Stage 1's tests run the fold in-process from the model entry
  and a fixture doc index, as `model.test.ts` does; CI runs `pnpm test` without
  `pnpm build`.
- The fold and the render live in `apps/desktop/src/shared/uxdocs.ts` so the script and
  the tests import one implementation:
    - `fold(model: UxModel, anchors: Anchors, docs: DocCommandEntry[], interactions): UxDocs`
    - `render(docs: UxDocs): Map<string, string>` — path → page text
- `UxDocs` (zod, `.strict()` throughout, so a rule module emitting a shape the fold does
  not expect fails the build by name):
    ```
    UxDocs        { swept: { at, sha }, commands: UxPage[], effects: UxPage[], editors: UxEditor[],
                    situations: UxModuleSituations[], interactions: UxInteraction[], shortcuts }
    UxPage        { id, kind: 'command' | 'effect', doc?: DocCommandEntry, drawn: UxRow[],
                    refused: UxRefusal[], reachedAfter: UxAfter[], anchored: boolean,
                    paletteOnly?: string, shortcuts: string[], menus: UxMenu[] }
    UxRow         { editor, module, situations: string[], label, tooltip, props: Record, then: string[] }
    UxRefusal     { editor, module, situation, says, more?, reasonFrom?: 'stack' }
    UxAfter       { editor, module, situation, first: string }
    UxMenu        { editor, module, situation, when, label, props? }
    ```

## Stages

Each stage is green under `pnpm check`, `pnpm test`, `pnpm lint` on its own.

1. **Fold and render.** `shared/uxdocs.ts`, `scripts/gen-ux-docs.mjs`, `build:uxdocs`, the
   `dev.desktop.mjs` call. Tests, all in-process: every registry command and every effect
   the model records has a page; every one of the model's 84 refusal sentences appears on
   exactly the pages whose first action carries it; the fold of the committed model has
   678 `drawn` rows (the test states the number, so a rules change that alters it is
   noticed the way `model.test.ts` notices); a `then` action appears once on its own
   page's "Reached after"; golden pages for a command with refusals, a command with no
   records, an effect, and one editor.
2. **The three read tools.** `agent/uxdocs.ts`, `uxDocsDir()`, registration in
   `session/core.ts`, `describeShowMe`, `README.md`'s text. Tests: escape refused; list,
   read and search over a temp tree; the search cap; `show_me`'s description omits the
   pointer when the tools are absent.
3. **`ux_check`.** `checkFor` moved to `shared/precheck.ts` (renderer import updated),
   `SessionDeps.checkCommand`, the wiring in `sessionaccess.ts`, the tool. Tests: a
   refused command in a testkit project comes back as `refuse` with the rule's own
   sentence; a command with a required number prop and no value comes back `unjudged`
   naming it.
4. **Smoke.** The `uxDocsDir()` check in `smoke.ts`.
5. **Docs.** `docs/reference/guided-tours.md` §"Sources of tours" gains the tree and the
   four tools; `docs/reference/vnauthor.md` §"Tools" gains a paragraph after its table
   naming the desktop-only tools the table omits (`show_me`, the history tools, and these
   four); `docs/reference/desktop-app-editors-misc.md`'s resource-resolution paragraph
   (around line 494) gains `uxDocsDir()` and why it is not an `extraResources` path;
   `docs/research/ux-behaviour-model.md` §"The readers already exist" and
   `docs/research/agent-access-to-the-ux-command-system.md` Position B each get a pointer
   here. `CLAUDE.md`'s command table gains nothing, because `build:uxdocs` runs inside
   `pnpm build`.

## Out of scope

- **`ux_targets`.** `interaction.targets` runs in main and builds its state from props
  (`docs/reference/command-system.md` §interactions), so it could be a tool, and Position
  B in the research doc proposes it beside `command.check`. It is left out because it is a
  registry command the agent would run, and "the agent does not reach the registry"
  (`CLAUDE.md`, Command system) is a line this plan does not cross; `stack.check` is a
  read the tour already performs on the agent's behalf. The `interactions/` pages carry
  what is static. If gesture steps turn out to be what the agent gets wrong, `ux_targets`
  is a one-tool follow-up with the same deps shape as `ux_check`.
- **`vnauthor`.** The pages are static, so the CLI could read them, but its author is in a
  terminal rather than in the app, and the tree only exists once the desktop app has been
  built. The tools take a root and a check as deps, so wiring `vnauthor` later is a host
  change with no change here.
- **Substituting fixture ids in sentences.** Needs a per-situation fixture-id table that
  no rule module exports. Verbatim plus a warning is what ships.
- **Committing the tree instead of `ux-model.json`.** A per-command Markdown diff is a
  better review surface than the JSON's, and a later plan could swap which derivative is
  committed. This plan adds a reader and changes nothing about what is committed.
- **A skill that teaches the procedure.** `describeShowMe` and `README.md` carry it. If
  the transcripts show the model still skipping the read, a builtin skill is the next
  step, not a bigger description.
- **The debug agent** (`@vn/agentreport`) reads a source snapshot that denies `dist`
  (`sourcemap.ts`), so it will not see this tree, and already sees the two JSON files. It
  is a different host with a different question; nothing here changes what it reads.

## Cost to undo

Low. Everything is additive: four tools, one optional `SessionDeps` field, a build script
and a dev-script call, one shared module, a moved function, doc paragraphs. A persisted
thread that called the tools resumes after they are removed, because `loop.ts` repairs a
dangling tool call. The sticky residue is `describeShowMe`'s pointer and the README, which
revert together.

## As shipped

All five stages landed, one commit each, in the plan's order, on 2026-09-21. `pnpm check`,
`pnpm test` (4,947 tests, 339 suites) and `pnpm lint` are green after each. The tree the
generator writes for the committed model is 268 pages: 192 commands, 12 effects, 22
editors, 31 modules, 9 interactions, `shortcuts.md` and `README.md`. Nothing under
`renderer/pathux/editors/**` changed, so `anchors.json` was not re-swept, and no command
was added, so `paletteonly.ts` and `ux-model.json` are untouched.

### Deviations

- **`DocCommandEntry` gains `description`.** The page opens with the doc-index entry,
  which the plan describes as "title, description, notes", but `toDocIndex` carried no
  `description` (the runtime catalog did). One field was added in `@vn/commands`; the
  command-table generator ignores it.
- **`fold` takes a fifth argument, the effect catalog, and `UxPage` carries `effect?`.**
  An effect page opens with the effect's title and description and lists its props, which
  come from `toEffectCatalog(createDesktopEffects())` rather than from the model. Every
  effect in the catalog gets a page; that is the same set as "every effect the model
  records", because `model.test.ts` already fails when a declared effect is offered
  nowhere. `UxAnchors` (`UX_ANCHORS`) names the four fields of `anchors.json` the fold
  reads.
- **The drawn-row count is 447, not 678.** The plan's count folded by verdict as well, so
  it counted refused controls and menu entries as rows. The shipped fold keeps those in
  their own tables ("Refused when" and the menu lines under "Reaching it"), and `drawn`
  holds accepted controls only. Twins in one situation that agree on everything the row
  carries (the Page editor's four corners) fold into one row, so the sum of situations
  over rows is below the count of accepted records; the test asserts every accepted record
  lands on its page under its situation rather than a one-to-one count.
- **Props are rendered verbatim, with no `<row>` substitution.** The plan's example
  renders `scene=sample` as `scene=<row>`, but nothing exports which prop values are
  fixture ids, which is the same reason substituting ids in sentences is out of scope. The
  README's warning covers props and menu `when` keys along with sentences.
- **"Reaching it" opens with a `Sweep:` line rather than `Control:`.** `anchors.json`'s
  `anchored` counts a menu entry as an anchor, so a command drawn only in a menu is
  anchored with no control; the line says "a control or menu entry ran it in the sweep of
  … at …" or "nothing ran it in the sweep …", which is what the bit means.
- **A section with nothing to say is one sentence, not an empty table.** "No pane draws a
  control for it.", "Never, in any fixture.", "Nothing runs it as a later step of a
  click.", which cost less to read whole than a header row with no rows.
- **Stage 1's tests are two files, not one.** The renderer's typecheck (`check:renderer`)
  does not reach `src/main`, and the flat check does not reach `renderer/`, so one test
  cannot hold both a fresh `model()` and the registry.
  `renderer/rules/tests/uxdocs.test.ts` runs the fold over `model()` with a fixture doc
  index (one minimal entry per command the model reaches) and checks the structure: the 84
  refusal sentences, the 447 rows, "Reached after", menus, the sweep bit and the palette
  rule, the throw on an unknown id. `src/main/tests/uxdocs.test.ts` folds the committed
  `ux-model.json` (the file `model.test.ts` keeps equal to a regeneration, and what
  `uxmodel.test.ts` in main already reads) with the live registry and holds the
  command-coverage rule, the golden pages and the equality with what the generator entry
  writes. Neither reads `dist/`. The golden pages live in
  `src/main/tests/__fixtures__/uxdocs/` and are listed in `.prettierignore`, because the
  renderer writes unpadded tables and prettier would repad them.
- **`uxdocs-entry.ts` runs the fold and the render.** A `.mjs` script cannot import a
  TypeScript module, so the generator bundles `src/main/commands/uxdocs-entry.ts`, whose
  `uxPages(model, anchors)` parses both inputs and returns the page map. `loadEntry`
  gained rest arguments to hand the model and the sweep through; its other callers pass
  none.
- **`ux_read`'s refusal names the tree.** `path "x" is outside the UX docs tree`, the
  shape of `read_file`'s sentence with the subject corrected: the tree is not the
  workspace, and the sentence should not say it is. `ux_list` uses the same sentence.
- **`checkFor` takes `Asked` (`{ id?, props }`) rather than an `Anchor`.** `Anchor` is a
  renderer type, and `src/shared/` cannot import it; an anchor is structurally an `Asked`,
  so `tour.ts` passes one unchanged. `canBlank` is exported beside it for `ux_check`'s
  `unjudged` sentence, and `askedAs` moved with it. The test moved to
  `src/shared/tests/precheck.test.ts`.
- **`describeShowMe` is reached through `ShowMeDeps.pages`.** The tool's description is
  built from a `pages` flag on its deps rather than a second constructor argument, so the
  session passes one object; the function is exported and tested on its own.
- **The README is rendered in stage 1.** It is a page of the tree, so `render` writes it;
  stage 2 added nothing to it.
- **`AffectsHarness` gained `check`.** Stage 3's test runs `ux_check` against a real stack
  over a testkit project, and the harness in
  `src/main/commands/tests/__fixtures__/affects.ts` already held one; it now exposes
  `stack.check` beside `run`.
- **The research docs link to the archived plan.** Stage 5 pointed them at
  `docs/plans/agent-reads-the-ux-model.md` so `check:doclinks` stayed green; the archive
  commit retargets both links.

### Left undone

Nothing in scope. The follow-ups the plan names stay as named: `ux_targets`, `vnauthor` as
a host, fixture-id substitution, committing the tree in place of the JSON, and a builtin
skill if the transcripts show the model skipping the read.

## Review findings

A fresh-context review on 2026-09-21 returned sixteen findings. Each is fixed above or
answered here.

1. _"Neither file ships" is false; `dist/**` is already in the asar, so `extraResources`
   would ship the tree twice._ Fixed: the two JSON files are described as shipping in the
   debug agent's `source/` snapshot; the tree ships with `dist/`; the root is
   `__dirname`-relative; no packaging change.
2. _`ux_check` without props refuses on `invalid props`, not on state._ Fixed: `checkFor`
   moves to `shared/` and fills the missing props; a fourth state `unjudged` names a prop
   that cannot be filled.
3. _"11 refusal sentences" and "125 commands" are wrong._ Fixed: 84 sentences (the first
   count read a field the control offer does not have); 125 first-action ids including
   effects; stage 1's tests state the real numbers.
4. _Refusal sentences embed fixture ids; the example page was invented._ Fixed: verbatim
   with a warning on the README and on every "Refused when" header; substitution recorded
   as out of scope; the example is marked illustrative and its refusal belongs to the
   command shown.
5. _Which page a multi-action record belongs to was undecided._ Fixed: first action owns
   the row, later actions get "Reached after"; the `UxDocs` shape carries both.
6. _Effect pages invite a `command` step naming an effect; "what must be selected first"
   was overclaimed._ Fixed: effect pages open with the refusal sentence `checkTour` gives;
   the promise is now "which props the control already knows", which "Props known"
   answers.
7. _`search` has no cap._ Fixed: `UX_SEARCH_CAP`, with a truncation line.
8. _Menu prose needs a hand-written mapping._ Fixed: `when` renders verbatim in prefix
   form.
9. _`interaction.targets` runs in main; the dismissal was wrong and Position B recommends
   it._ Fixed: the research doc is cited in the problem statement; `ux_targets` is out of
   scope for the stated reason (a registry command run by the agent), with the follow-up
   named.
10. _`pnpm dev` never generates the tree; CI never builds; tests must not read `dist/`._
    Fixed: the generator runs at the start of `dev.desktop.mjs`; main logs the missing
    path; stage 1's tests are in-process.
11. _The deferred-discovery chain is unstated._ Recorded under "The tools" with the cost
    and why the six always-loaded tools are not widened here.
12. _`toDocIndex` and `gen-command-table.mjs` already render per-command Markdown with
    `notes`._ Fixed: the page's top is that entry, and the fold takes `DocCommandEntry[]`.
13. _JSON Lines was not considered._ Fixed: added to the format section with the honest
    trade (self-describing hits vs cheaper whole-page reads).
14. _Docs stage named sections that do not exist._ Fixed: `desktop-app-editors-misc.md`'s
    resource paragraph; a paragraph after `vnauthor.md`'s table rather than rows in it.
15. _`--smoke` runs with no session and cannot call a tool._ Fixed: a `uxDocsDir()` read
    check beside the builtin-skills one.
16. _`UxDocs` unsketched; refusal `description` unmentioned; who resolves the root; how
    `DESCRIPTION` becomes conditional._ Fixed: the shape is sketched; `More` carries the
    description; `uxDocsDir()` in `distribution/resources.ts`; `describeShowMe`.
