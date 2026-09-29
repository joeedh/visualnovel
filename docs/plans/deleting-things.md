# Deleting things

## Goal

Let an author delete characters, locations, wiki pages and other files from the desktop
app and through the agent, and let them reclaim the space taken by art nothing uses any
more, without leaving the project in a state the next pipeline run cannot read.

The decisions this plan implements were made by the owner on 2026-09-29 and are recorded
in [`../research/deleting-things.md`](../research/deleting-things.md#decisions). That
document also holds the survey behind them. This plan does not repeat the reasoning; it
says what gets built, in what order, and how each stage is checked. Where the plan narrows
or refines a decision, [Review findings](#review-findings-2026-09-29) says so and why.

## What gets built

- **A working confirmation gate.** The desktop's command confirmation gate currently
  returns yes for every command. The new gate shows the author a confirmation, and a
  command's form counts as one.
- **Tombstones in `tasks.jsonl`.** A record that removes a task from the replayed graph,
  shaped so an older build still reads the log.
- **A validation tool.** A read-only report of every reference that would fail a run or a
  read.
- **Entity delete commands.** `character.delete`, `location.delete` and `doc.delete`, plus
  new props on `story.deleteScene`. Each rewrites the references to what it deletes.
- **Menu entries.** The document tree's right-click menu offers Delete.
- **Agent tools.** The agent gets tools for the same deletes, and every tool call that
  removes a file asks the author first.
- **The collector.** `asset.collect` removes unused pictures, manifest rows, task records
  and gen-graph state.
- **Recovering from a missing picture.** A claims ledger in a shared `assets/` repository,
  `asset.recover` and `asset.forget`, a check that runs when `HEAD` moves, and a view that
  lists what is missing.
- **Pulling the nested `assets/` repository** along with the project.

## Facts this plan depends on

Established by reading the code on 2026-09-29. Each stage re-checks the ones it touches
before it starts.

- **Confirmation.**
    - `CommandStack.exec` asks `ctx.confirm` ("Run <title>?") for a `confirm: true`
      command and refuses on a no (`packages/commands/src/stack.ts:190-197`). `exec` never
      runs a command's `check` (`:560-568`).
    - The desktop wires `confirm: () => Promise.resolve(true)` with a TODO
      (`apps/desktop/src/main/runtime/stack.ts:114-116`). The only real confirmation in
      the app is the command form's two-click guard: the run button reads
      `confirm — <label>` between clicks
      (`apps/desktop/renderer/pathux/commands/commandform.ts:116-118`, `:359-364`).
    - A menu entry opens as a form only when the entry sets `form`
      (`apps/desktop/renderer/pathux/chrome/showmenu.ts:161`); the doc comment at
      `doctree.ts:454-458` states that as a convention, not a rule.
    - 25 commands are `confirm: true` today: `art.generate`, `art.redraw`, `art.promote`,
      `asset.restore`, `asset.unapprove`, `asset.upload`, `asset.adopt`, `asset.replace`,
      `asset.regenerate`, `gengraph.delete`, `gengraph.run`, `git.takeBack`, `git.goBack`,
      `git.removeRemote`, `git.abandonSync`, `notify.deleteAll`, `pipeline.draw`,
      `pipeline.approveAndRun`, `project.setArtStyle`, `project.setImageModel`,
      `project.installPages`, `story.decomposeAll`, `view.resetLayout`, `upload.files`,
      `upload.pick`. Some run without a form: the Project editor
      (`renderer/pathux/editors/project.ts:172`, `:185`) and the upload drop target
      (`pathux/agent/agent.ts:242`).
    - The existing `requestConfirm` channel (`session/core.ts:1054`, `runtime/ipc.ts:59`)
      draws its card in the agent conversation (`renderer/pathux/agent/agent.ts:161`). It
      is the agent's confirmation, not a general one.
    - CDP clients reach commands through `window.vn.exec`, and the preload marks those
      calls `source: 'cdp'` (`apps/desktop/src/preload/index.ts:46`).
- **Undo.**
    - A mutating command that is not undoable blocks undo from reaching past it: `undo`
      refuses with `"<id>" was not recorded as undoable`
      (`packages/commands/src/stack.ts:619-668`).
    - `onRecord` runs after every command and after every undo or redo, with
      `record.stack` set for the latter
      (`apps/desktop/src/main/runtime/stack.ts:133-170`).
- **The task log.**
    - `loadGraph` replays `vngen/state/tasks.jsonl` last-writer-wins per hash
      (`packages/taskgraph/src/log.ts:18`). It is the file's only reader.
    - `readJsonl` throws on the first line that does not parse
      (`packages/util/src/fs.ts:63-75`).
    - `topoOrder` iterates every node's `deps` (`packages/taskgraph/src/graph.ts:59-61`),
      so a record with no `deps` array breaks any build that replays it as a task.
    - The requeue already appends a copy of a task with `status: 'pending'` and no
      `output` (`apps/desktop/src/main/session/asset.ts:470`).
    - `vngen status` counts every node `loadGraph` returns, orphans included
      (`apps/cli/src/commands.ts:282-286`).
- **Asset stores.**
    - `AssetRoot` and `AssetStore` have no remove method
      (`packages/store/src/assetstore.ts`). Each persist rewrites the whole manifest from
      the instance's in-memory index (`:240-250`, `:295-300`), so another live instance
      resurrects rows this one removed.
    - `loadProject` opens a fresh `AssetStore` and runs `repairCurrent`, which writes the
      manifest (`apps/desktop/src/main/session/core.ts:643-663`,
      `packages/artgen/src/takes.ts:185-214`).
    - An adopted cross-root copy has a base `reference` row and a project `shot_image` row
      for one hash (`docs/reference/asset-stores.md:74-82`).
    - `concept` and `reference` rows have a `sourceTask` that is not a task in
      `tasks.jsonl` (`packages/artgen/src/concept.ts:107`, `upload.ts:114`).
- **Reachability.**
    - `buildSlotGraph` enumerates shots only from persisted storyboards of
      `reachableScenes` (`packages/artgen/src/slotgraph.ts:333-350`), and `usedOutfits`
      walks `reachableScenes` too (`packages/model/src/used.ts:65`). A scene not yet wired
      into the story contributes no slots.
    - A sheet row with no stated angle is not a candidate once a task log exists
      (`packages/artgen/src/refs.ts:108-113`).
    - `attachedRefs` and `upstreamOf` reach pins only on rungs that have an asset row
      (`packages/artgen/src/upstream.ts:17`, `:37`).
    - Graph documents and group definitions (`vngen/work/graphs/lib/<ref>.json`) name
      asset hashes in a `GenImageFile` node's `props.hash` and in the seeded `assets` prop
      of `GenTaskRefs` and `GenSheetRefs` (`packages/gengraph/src/nodes/runtimes.ts:196`,
      `:200`, `:277-288`).
    - `story.play.json` names pictures by `{hash, ext}`
      (`packages/types/src/playable.ts:7-17`), and the site builder skips a missing one
      with a report (`packages/export/src/site-cli.ts:78`).
- **Gen-graph state.**
    - The blob store exposes `read`, `has` and `write` only
      (`packages/gengraph/src/blobs.ts:14`).
    - A new graph created with a deleted graph's slug picks up the old journal and blob
      folder (`packages/pipeline/src/graphload.ts:87`,
      `apps/desktop/src/main/session/gengraph.ts:200`). That is a bug today, and the
      collector fixes it as a side effect.
    - A graph document that exists but does not parse is reported as a problem, not
      treated as absent (`packages/pipeline/src/graphload.ts:82-85`).
- **Layering.**
    - The allow-lists are in `eslint.config.mjs:18-168`: `@vn/scriptedit` may import
      types, util, parse, model and store; `@vn/artgen` may import taskgraph but not
      gengraph or git; `@vn/gengraph` may import artgen, taskgraph and store but not git;
      `@vn/authoring` may import scriptedit, artgen, gengraph and git but not taskgraph.
    - **Nothing enforces the allow-lists today.** `pnpm lint` runs lintrix, whose config
      has no boundaries rule, and eslint is not a dev dependency (`package.json:30-31`).
- **Concurrency.** Within the desktop app, `busy()` reports a running pipeline and
  `pipeline.run` refuses while it is set (`apps/desktop/src/main/session/core.ts:927`,
  `commands/pipeline.ts:52`). Nothing locks across processes.
- **Git sync.** `git.pull` pulls one repository role and never a nested one
  (`apps/desktop/src/main/session/sync.ts:255-285`).
- **Window focus.** `win.on('focus')` exists and only touches the window registry
  (`apps/desktop/src/main/runtime/windowmanager.ts:167`).
- **Committed files under `.vnstudio/`.** `.vnstudio/pages/vn-site.mjs` and
  `.vnstudio/layouts/` are committed (`main/distribution/pages.ts:22`,
  `commands/view.ts:231`); `session.json` is ignored by its own line (`SESSION_IGNORE`,
  `workspace/workspace.ts:40`).
- **Names.** The command that drops a pin is `prompt.dropRef`. Its rule is
  `applyPromptEdit` in `apps/desktop/src/main/agent/promptedit.ts`, which `vnauthor`
  cannot import. The `doc.move` roots and `rootProblem` are in
  `apps/desktop/src/shared/fileops.ts:14-74`, which `vnauthor` cannot import either.

## Where the code lives

- **Delete rules** go in `@vn/scriptedit`, beside `deleteScene`, because both the desktop
  app and `vnauthor` must run them.
    - The pin-dropping part is a pure function over `PromptOverride` (a `@vn/types`
      shape), written in `@vn/scriptedit`. `applyPromptEdit` stays where it is.
    - Moving `start:` needs `setStartScene` from `@vn/config`, which `@vn/scriptedit`
      cannot import. The rule returns the new start id, and each host applies it.
    - A rule returns which shots it changes. Pricing those changes needs artgen's
      `resolveSlot` and `slotTaskHash`, which `@vn/scriptedit` cannot import, so
      `priceShotChanges` in `@vn/artgen` does it, and each host calls both.
- **File roots.** `FILE_ROOTS` and `rootProblem` move from
  `apps/desktop/src/shared/fileops.ts` into `@vn/types`, which is already home to pure
  functions (`chatRouteFor`) and is importable by the renderer, main and `vnauthor`.
  `shared/fileops.ts` re-exports them.
- **Validation and collection** are split along the layering.
    - `@vn/artgen` holds the parts over the model, the asset stores and the task log.
    - `@vn/gengraph` holds the parts over graph documents, group definitions, journals and
      blobs.
    - `validateProject` and `collectProject`, which run the artgen and gengraph halves
      together, also live in `@vn/gengraph`. It is the one leaf package that may import
      `@vn/artgen` and that both the desktop app and `vnauthor` may import.
    - Neither half may import `@vn/git`. Whether a picture can be restored from git is
      computed by the host (desktop session or authoring tool) and added to the plan.
    - Rejected: a new leaf package for `validateProject` and `collectProject`. It would
      hold two functions and need its own layering entry.
- **Commands** are thin wrappers in `apps/desktop/src/main/commands/`, as the shipped
  deletes are.
- **Agent tools** go in `packages/authoring/src/tools/`.
- **Imports are checked by hand.** Because nothing enforces the allow-lists, each stage's
  review greps its new imports against `eslint.config.mjs:18-168`. Restoring automated
  enforcement is out of scope and is raised with the owner separately.

## Stages

Each stage is one commit on `master` and leaves `pnpm check`, `pnpm test` and `pnpm lint`
green. Each stage updates the reference docs it changes in the same commit.

The `frontend-design:frontend-design` skill is consulted where a stage draws something
new. It gives general direction; the app's own rules still govern: path.ux widgets, the
existing stylesheet, `act()` and `Offer` for every control, and a tooltip on everything
the author can press (`CLAUDE.md`, "Tooltips").

### Stage 0: remove dead helpers

- Delete `writeBreakdown` (`packages/store/src/worktree.ts:78`), and `outfitSheetDir`,
  `locationBreakdown`, `locationRefsDir` and `reviewsDir`
  (`packages/store/src/paths.ts:113`, `:116`, `:119`, `:143`). None has a caller outside
  the set.
- Re-grep across `apps/` and `packages/` first, tests included.

### Stage 1: a working confirmation gate

The owner's decisions rely on confirmation in three places: every location delete, every
delete in a project the app does not commit in, and the collector. The first and third are
static (`confirm: true`). The second depends on the project.

- **Conditional confirmation.** A command may declare
  `confirmWhen(props, ctx): Promise<string | undefined>`. `CommandStack.exec` evaluates it
  inside its serialized chain, only for commands that declare it, and asks when it returns
  a sentence. A `confirm: true` command asks with its fixed sentence. `check` is not used
  for this: `exec` does not run it, and some checks are expensive (`pipeline.run` plans
  the project).
- **A confirmed exec.** `exec` takes an option `confirmed: true`, and the stack does not
  ask when it is set. The command form passes it after its two-click guard, so a form is
  never followed by a second question. Main also treats `source === 'cdp'` as confirmed,
  so the anchor sweep and tours keep working; the CDP script itself does not change.
- **The desktop gate asks.** `ctx.confirm` pushes a `command:ui` effect
  `{ type: 'confirm', id, sentence }` to the window that ran the command, and awaits the
  answer on a new `command:confirm` channel. The renderer shows a small popup with the
  sentence, Cancel and a confirm button labelled with the command's title. A closed window
  or a missing answer counts as no.
    - Rejected: routing through `requestConfirm`. That card is drawn in the agent
      conversation, which is the wrong place for a command the author ran from an editor.
    - Direct callers (the Project editor, the upload drop target) now see a real
      confirmation before their `confirm: true` command runs. That is the intended fix,
      and each of the 25 commands listed under Facts is exercised by hand once.
- **The affects harness** wires `confirm: () => true`
  (`apps/desktop/src/main/commands/tests/__fixtures__/affects.ts:138-140`) and keeps it.
- **Frontend design.** Consult the skill for the confirmation popup and for how the form
  shows a `confirmWhen` sentence beside its armed button, including a long one (a delete's
  rewrites, a collector's byte count).
- **Tests.** Stack tests for `confirm`, `confirmWhen`, `confirmed` and a declined
  confirmation. A main-side test that a `cdp` call is not asked. A renderer test that the
  effect opens the popup and its answer resolves the call.
- **Docs.** `docs/reference/command-system.md` (confirmation), and the TODO at
  `runtime/stack.ts:114` goes.

### Stage 2: tombstones in `tasks.jsonl`

- **Record.** A tombstone is a full copy of the task's last record with
  `status: 'pending'`, no `output`, no `error`, and `removed: true`, written by a new
  `logTombstone(paths, task)` in `@vn/taskgraph`. It is the requeue's shape plus one
  field.
    - A build that predates this stage reads it as a requeued task: valid, with `deps`,
      and planned again if the model asks for it. A build with this stage leaves the hash
      out of the graph.
    - Rejected: a minimal `{ hash, removed }` record. An older build replays it as a task
      with no `deps`, and `topoOrder` throws, so one collaborator on an older build could
      not load the project.
- **Replay.** When the last record for a hash has `removed: true`, `loadGraph` leaves the
  hash out. A later task record for the same hash supersedes the tombstone.
- **Nothing else reads the file.** `vngen status` and the Task Graph pane stop showing
  tombstoned tasks as a consequence.
- **A line that does not parse** still throws in `readJsonl`, as it does today. Changing
  that is out of scope.
- **Tests** in `packages/taskgraph/src/tests/`: tombstone after `done`, task after
  tombstone, and an old-shape replay (the tombstone read without the new rule) that plans
  and orders without throwing.
- **Docs.** `docs/reference/pipeline-contracts.md`, the task-graph section.

### Stage 3: the validation tool

- **A load path without repair.** Validation reads the manifest and the task log without
  running `repairCurrent`, which writes. Otherwise the tool is not read-only, and the "two
  current rows" check could never fire.
- **Findings** have a severity. **Blocking** means the next run or a read would fail:
    - a `done` task whose `output` has no file in either root;
    - a manifest row with no file;
    - a character's `approved_portrait:`, a `Shot.image`, or a `ChunkRef.pin` on any
      override rung that names no manifest row (pins are found by walking the overrides
      directly, not through `attachedRefs`);
    - a hash named by a graph document or a group definition that has no manifest row;
    - a slot with two current rows.
- **Information** findings report stale state that fails nothing:
    - a file under a root's object folder with no manifest row;
    - an `Asset.refs` entry with no row, which a redraw already drops
      (`concept.ts:199-204`);
    - a `story.play.json` naming a picture that is gone, so the playable needs
      re-exporting.
- **Where.** `validateAssets` in `@vn/artgen`, `validateGraphs` in `@vn/gengraph`, and
  `validateProject` in `@vn/gengraph` returning one list:
  `{ severity, kind, hash?, where, referrer, message }`.
- **Command.** `project.validate`, non-mutating, from the palette and from a menu entry on
  the document tree's project branch. Its result is a notification listing the findings;
  stage 8 links it to the missing-pictures view.
- **Agent tool.** `validate_project`, non-mutating, so it runs in plan mode.
- **Not in the CLI.** `apps/cli` may not import artgen or gengraph, so a `vngen validate`
  is deferred.
- **Tests.** A testkit project run through the mock pipeline, then damaged file by file,
  one finding asserted per damage, including a group definition naming a missing hash and
  a stale `story.play.json`.

### Stage 4: entity delete commands

- **Rules** in `@vn/scriptedit`. Each returns one plan: scene writes, shot-file writes,
  sheet writes (overrides), files and folders to remove, an optional new `start:`, the
  shots whose inputs change, and prose mentions.
    - **`planCharacterDelete(state, { id, lines, mergeInto? })`.** `lines` is `narrate`
      (default), `delete` or `merge`.
        - Dialogue: narration, deleted, or given to `mergeInto`, for every line the
          character speaks.
        - `[[outfit:]]` markers naming the character are cleared.
        - The character leaves every shot's subjects; a shot left with nobody becomes a
          background plate. Its outfit overrides go with it.
        - Pins whose `from` binding names the character, or whose hash is one of the
          character's takes, are dropped from every override.
        - Removed: the sheet file (conventional or tagged), and
          `vngen/work/characters/<id>/`.
    - **`planLocationDelete(state, { id, replaceWith? })`.** Refused without `replaceWith`
      while any scene is set at the location.
        - Each such scene's heading names `replaceWith` instead, keeping INT/EXT and the
          time of day.
        - `Shot.location` variants of the deleted location reset to the default.
        - Pins on the location or its takes are dropped.
        - Removed: the sheet file, and `vngen/work/locations/<id>/` if it exists.
    - **`deleteScene` gains `edges`**: `bypass` (default) or `cut`.
        - `bypass` points each `next` and each choice that named the deleted scene at the
          deleted scene's own `next`. When the deleted scene has no `next`, `bypass` is
          refused by name and `cut` is offered.
        - `cut` clears those `next` fields and removes those choices.
        - When the deleted scene is `start:`, the new start is its `next`. With no `next`,
          the delete is refused, as today.
    - **Mentions**: scenes and wiki pages whose prose names the entity (display name or
      id, whole word, case-insensitive). Listed, never rewritten.
- **Cost.** `priceShotChanges` in `@vn/artgen` counts the changed shots whose task hash
  moves and how many of them already have a rendered frame. Each host calls it with the
  rule's changed shots, and the check reports both counts.
- **Commands.**
    - `character.delete` and `location.delete`, new namespaces. `location.delete` is
      `confirm: true`. Both are `undoable: true`: every file they rewrite is in the
      document class. `approved.png` is media and is not restored, which the check says.
    - `story.deleteScene` gains the `edges` prop and the `start:` move. Its `affects`
      gains `project.yaml`, and it joins `REFETCHES_PROJECT`
      (`renderer/pathux/app/bridge.ts:273`).
    - `doc.delete(paths)` deletes files and folders under `FILE_ROOTS`. It refuses an
      entity sheet by name and names `character.delete` or `location.delete`, and refuses
      a folder that contains one. A media file is allowed, and the check says undo will
      not restore it but the commit will. It takes several paths, like `doc.move`.
    - **In a project the app does not commit in** (not owned, or no repository), every
      command whose plan removes a file declares `confirmWhen`, returning a sentence that
      the delete can be undone only until the app closes. That is the new commands plus
      `story.deleteScene`, `story.mergeScene`, `story.deleteShot`, `story.deleteLine`,
      `story.deleteLines` (line deletes can remove a storyboard file through shot fallout,
      `packages/scriptedit/src/shotfallout.ts:37-44`) and `gengraph.delete`.
- **Registration**, for each new command: `commands/index.ts`; the exact lists in
  `commands/tests/commands.test.ts`; a run in `commands/tests/affects.test.ts` (the
  fixture has characters `aiko` and `haruki` and locations `classroom`, `rooftop` and
  `hall`); `renderer/rules/paletteonly.ts` until stage 5 draws a control;
  `pnpm gen:uxmodel`; `apps/desktop/anchors.json`'s command list; and
  `pnpm gen:command-table`.
- **Frontend design.** Consult the skill for the delete forms: how a check listing
  rewrites, prose mentions and a re-render count reads before the author confirms, and how
  the `lines`, `mergeInto`, `replaceWith` and `edges` choices are laid out.
- **Tests.**
    - Rule tests in `packages/scriptedit/src/tests/` for each rewrite and each refusal.
    - Session tests in `apps/desktop/src/main/tests/`, where the commands and the undo
      journal exist, over a testkit project: run the mock pipeline, delete, plan again and
      assert the plan reads, `validateProject` reports nothing blocking, and undo restores
      every document.
- **Docs.** `docs/reference/command-system.md` (the new namespaces).

### Stage 5: Delete in the document tree

- **Entries in `menuFor`**, each with `form: true` set on the entry:
    - character and location rows: `character.delete` / `location.delete`;
    - scene rows: `story.deleteScene`;
    - wiki, file and dir rows: `doc.delete`;
    - graph rows keep their shipped entry.
- **Multiselection.** `markedMenu` gains Delete n, running `doc.delete` over the marked
  paths. A selection that includes an entity sheet is refused by the check, naming it.
- **Not offered:** assets and slots (the collector handles pictures), skills (no decision
  covers them), and the `more` and `assetkind` rows.
- **Keyboard.** The Delete key opens the same form, through a row in
  `renderer/rules/shortcuts.ts` beside Cut and Copy (`:223-240`).
- **Frontend design.** Consult the skill on where Delete sits in each menu (grouping,
  separators, wording), so a destructive entry is not next to a routine one.
- **Registration.** `renderer/rules/situations/doctreemenu.ts` situations,
  `pnpm gen:uxmodel`, the CDP anchor sweep, and each command leaves `paletteonly.ts`.
- **Docs.** `docs/reference/document-tree.md`: the menu table gains the entries (and the
  `graph` and `branch:graphs` rows it already omits), and "Deliberately absent" loses
  deleting. `docs/reference/guided-tours.md` if its shortcut list names Cut and Copy.

### Stage 6: agent tools

- **The agent's route** is the owner's option 3: a delete tool removes the references that
  need no decision and refuses, by name, while any reference that needs one remains. The
  agent plans those rewrites with its existing tools and then deletes.
    - `delete_character`: refuses while the character speaks any line.
    - `delete_location`: refuses while any scene is set there.
    - `edit_scene op=deleteScene`: keeps its shipped refusal on incoming edges, and moves
      `start:` as the command does.
    - `delete_files`: the `doc.delete` rule, over `FILE_ROOTS` from `@vn/types`.
- **Every call that deletes a file asks the author.**
    - The new tools are `confirm: true`, with `confirmDetail` cases
      (`apps/desktop/src/main/agent/toolconfirm.ts:26`) so the card says what goes rather
      than showing raw JSON.
    - `edit_scene` asks through `ctx.confirm` whenever the plan's `removed` list is not
      empty, before applying it. That covers `deleteScene`, `mergeScene`, `deleteShot` and
      line edits whose shot fallout removes a storyboard file.
    - `ctx.confirm` today reports every question as `run_skill`
      (`packages/authoring/src/loop.ts:570-574`). It gains the calling tool's name, so the
      desktop card and `vnauthor`'s prompt name the right tool.
- **Tests** in `packages/authoring/src/tests/`: each refusal, each confirmation, the tool
  name on the question, and a declined confirmation writing nothing.
- **Docs.** `docs/reference/vnauthor.md` (the tools).

### Stage 7: the collector

- **Store primitives.** `AssetRoot.remove(hashes)` removes rows and rewrites the manifest;
  `AssetRoot.removeFiles(hashes)` removes the bytes. They are separate so the caller
  controls the order. A blob-store `list()` and `remove(refs)` in `@vn/gengraph`.
- **Live rows.** Liveness is decided per row, not per hash, because one hash can have a
  row in each root. A row is live when any of these holds:
    - its own `satisfies` binds it to a slot the collector enumerates (below);
    - its hash is the `output`, or any `attempts[].output`, of a live slot's task, which
      keeps legacy sheet rows that are not candidates;
    - its hash is named by a live reference: an `approved_portrait:`, a `Shot.image`, a
      pin on any override rung, a graph document or group definition, or the claims ledger
      under another project's id (stage 8);
    - it is a `concept` or `reference` row (see Review findings, item 12);
    - its hash is in the `Asset.refs` of a live row (transitively).
- **Enumerated slots.** The collector does its own enumeration rather than calling
  `buildSlotGraph` unchanged, because changing the shared helpers would change planning:
    - shots from **every** scene's persisted storyboard, so an unwired scene keeps its
      frames;
    - sheets for **every** outfit each character defines, cast or not, so an approved
      sheet for an outfit no shot uses yet is kept;
    - portraits and plates as `buildSlotGraph` enumerates them.
- **Base rows this project did not make are never removed.** In a shared `assets/`
  repository, a base row is a removal candidate only when its `sourceTask` is a task in
  this project's `tasks.jsonl`. Pictures another project generated are left alone even
  when this project does not reference them.
- **What is removed:** every non-live row and its file in its root; a tombstone for every
  task whose `output` is removed, and for every `failed` or `needs_human` task that no
  enumerated slot's task hash names; the journal and blob folder of every graph whose
  document file does not exist (a document that exists but does not parse is left alone);
  blobs no journal record names; and, with `oldAnswers: true` only, blobs named only by
  superseded `done` records.
- **Order:** tombstones, then both manifests, then the files, then graph state. A crash
  after the tombstones leaves unreferenced files, which the next collection removes.
- **Stale store instances.** The desktop collector runs against the session's own
  `AssetStore` and reloads the project afterwards, so no instance in the app writes an old
  index back. Another process holding a store (a terminal `vngen run` or `vnauthor`) can
  still resurrect removed rows on its next write; the docs say so.
- **`collectProject`** in `@vn/gengraph` returns a plan (per-root rows, files, bytes,
  tombstones, graph state) before it applies anything. The host adds, per removed file,
  whether `git cat-file -e HEAD:<path>` finds it in the repository that holds it, and the
  check reports those that are not restorable.
- **Command.** `asset.collect`, `confirm: true`, `undoable: false`.
    - `affects`: `assets`, `vngen/build`, `vngen/state`.
    - **It ends in-app undo.** A non-undoable command blocks undo from reaching past it,
      and the collector rewrites `assets/manifest.json`, which is in the snapshot, so the
      drift guard would refuse anyway. After a collection, the ways back are
      `git.takeBack`, `git.goBack` and the agent's revert. The check says so.
    - Refused while `busy()` reports a pipeline run.
    - Commit-on-save commits the project repository and, when `assets/` is its own, that
      one too.
    - Reachable from the palette and from a form entry on the document tree's Assets
      branch.
- **Agent tool.** `collect_unused_assets`, `confirm: true`. `ToolContext` gains a `busy()`
  seam the desktop fills from the session and `vnauthor` answers false.
- **Frontend design.** Consult the skill for the collector's form: a report that can run
  to hundreds of pictures needs a summary first (counts and bytes per root, how many are
  not in git) and the detail behind it.
- **Tests.** A testkit project: mock run; delete a character and a scene; add an unwired
  scene with a storyboard and rendered frames; add an adopted cross-root copy whose shot
  is then deleted; create and delete a graph; then collect. Assert the unwired scene's
  frames and the base `reference` row stay, the deleted entities' rows go, the adopted
  copy's project row goes, tombstones are written, `validateProject` finds nothing
  blocking, and a second mock run plans without reading a missing file. A second test
  crashes between tombstones and manifests and asserts the next collection finishes the
  job. A third shares `assets/` with a second project and asserts the second project's
  pictures stay.
- **Docs.** `docs/reference/asset-stores.md` ("What this does not do" loses "Collect
  garbage"), `docs/reference/pipeline-contracts.md` (the collector, its order, and that it
  ends in-app undo), `docs/reference/gen-graphs.md` (pruning is built; a reused slug no
  longer inherits a journal once the collector has run).

### Stage 8: recovering from a missing picture

- **Project identity.** A `project_id` field in `project.yaml`: a random id, written once
  the first time the project claims an asset, through a textual writer like
  `setStartScene` (`packages/config/src/config.ts:365-379`) and a schema field.
    - Rejected: the folder name, which differs per clone, and the repository's root
      commit, which every project in a monorepo checkout shares.
    - A project folder copied by hand keeps the id, so the two copies share claims until
      one is given a new id. No command does that in this plan; the docs say how to do it
      by hand.
- **The claims ledger.** One empty file per claim, `assets/claims/<hash>/<project_id>`, in
  the `assets/` repository. Two projects claiming at once add different files, so a rebase
  pull cannot conflict on them. Rejected: a single `claims.json`, which conflicts whenever
  two projects claim between pulls.
    - `asset.recover` adds the recovering project's claim on a base asset.
    - The collector skips hashes claimed by any other project, and removes this project's
      own claim on a hash it no longer references.
- **`asset.recover(hash)`.**
    - Finds the commit that deleted the file (`git log -1 --diff-filter=D` on the object
      path, in the repository that holds it) and restores the bytes and the manifest row
      from its parent.
    - When the latest record for a task whose `output` is this hash has `removed: true`,
      appends a copy of the last `done` record whose `output` is this hash, with
      `restored: <ISO time>` added.
    - Refused, by name, when the file is not in git history.
    - `undoable: false`: it writes the object folders, `vngen/state`, and
      `assets/manifest.json`, `project.yaml` and the claims under `assets/`, and undo
      would roll back the documents but not the bytes or the log.
- **`asset.forget(hash)`.** Removes this project's references with the stage 4 rules
  (pins, `Shot.image`), clears `approved_portrait:` and `status` on the sheet directly
  (`clearCharacterApproval`, `removeApprovedPortrait`) because the shipped unapprove path
  refuses once the manifest row is gone (`session/asset.ts:317-321`), and tombstones the
  task that produced it. `undoable: false`, for the same reason as `asset.recover`.
- **When the check runs.** The blocking missing-picture findings of `validateProject` run:
    - after a project opens, following `Committer.sweep` in `openRepos`
      (`apps/desktop/src/main/runtime/workspacelifecycle.ts:192-224`);
    - when a window gains focus and a repository's `HEAD` differs from the one last
      checked, from the existing `win.on('focus')` handler;
    - after `git.pull`, `git.continueSync`, `git.takeBack`, `git.goBack` and
      `git.restoreFile`, and after the agent's `git_revert` and `git_restore`, which run
      in process while the window keeps focus;
    - after an undo or redo (`onRecord` with `record.stack` set).
- **Where the last-checked `HEAD` lives.** `.vnstudio/assetcheck.json`, one entry per
  repository role, ignored by its own line added through `writeScaffolding` like
  `SESSION_IGNORE`. The rest of `.vnstudio/` stays committed.
- **The view.** A missing-pictures view in the History pane's detail column, shown when
  the last check found anything, beside the conflict view it is modelled on. One row per
  missing picture: what it was (its slot label, or `hash8` when none), what references it,
  and Recover and Forget buttons drawn through `act()`, each with a tooltip; Recover is
  disabled, with the refusal as its tooltip, when the file is not in git. A notification
  links to the view when the check finds something new.
- **Frontend design.** Consult the skill for the view: how it sits beside the conflict
  view, how a row reads without a picture to show, and how many rows fit before it needs
  grouping.
- **Registration.** A rule module and situations for the view
  (`renderer/rules/history.ts`), `pnpm gen:uxmodel`, and the anchor sweep.
- **Tests.**
    - Two testkit projects sharing an `assets/` repository: B recovers a plate that A
      generated and collected; A collects again and the plate stays because B claims it.
    - Revert after a collection: delete a character, collect, `git.takeBack` the
      collection's commit and the delete's; the check finds the portrait; Recover restores
      it and appends its `done` record; the next mock run renders nothing.
- **Docs.** `docs/reference/history-pane.md` (the view),
  `docs/reference/repos-and-commits.md` (the ledger and `project_id`),
  `docs/reference/pipeline-contracts.md` (a recovered `done` record restates one the log
  holds; it is not a forged record).

### Stage 9: pull the nested `assets/` repository

- `git.pull` on the project role also pulls the `base` role when that repository is owned,
  checked out, and has a remote; without a remote it is skipped with a note. `assets/` is
  pulled first, so the project's references are checked against the pictures they name.
- If the `assets/` pull stops on a conflict, the project is not pulled. The History pane
  shows the stopped pull as it does today, and after it is resolved the author runs Get
  their saves again, which pulls the project. Nothing is remembered across a restart.
- `SyncOutcome` carries one outcome per repository pulled, each with its own `rewrote`
  table.
- **Tests.** Sync tests with a nested `assets/` repository: both pulled; an `assets/`
  conflict stops before the project; a base with no remote is skipped.
- **Docs.** `docs/reference/history-pane.md` and `docs/reference/repos-and-commits.md`.

## Out of scope

- Deleting skills and threads.
- A CLI `vngen validate` or `vngen collect`.
- Compacting `tasks.jsonl`.
- Locking the project against another process (a terminal `vngen run` or `vnauthor`)
  during a collection.
- Making `readJsonl` tolerate a line that does not parse.
- Restoring automated enforcement of the package allow-lists.
- A command that gives a copied project a new `project_id`.

## Finishing

The checklist in
[`../reference/conventions.md`](../reference/conventions.md#finishing-a-plan) applies. In
addition, the row in [`index.md`](index.md) flips to shipped and this file moves to
`archive/`, with the link from `docs/research/deleting-things.md` updated.

## Review findings, 2026-09-29

A fresh-context review attacked the first draft. Each finding is listed with what was done
about it.

1. **In-app undo cannot reach past a collection.** Fixed in the plan: stage 7 says the
   collector ends in-app undo, and stage 8's test uses `git.takeBack`. This narrows the
   owner's decision "undo or revert after a collection is resolved like a pull" to the
   revert routes; raised with the owner.
2. **The live-root set missed references.** Fixed: group definitions are walked, the
   collector enumerates every scene and every defined outfit itself, a live slot's task
   outputs are roots, liveness is per row, and `story.play.json` is checked by the
   validator.
3. **Stage 1 relied on `check`, which `exec` never runs.** Fixed: `confirmWhen`, evaluated
   in the exec chain. The 25 `confirm: true` commands are listed. The CDP bypass is keyed
   on `source === 'cdp'` in main. The `requestConfirm` channel is rejected with a reason.
   The `NEEDS_CONFIRM` refusal is gone, because the gate now asks directly and direct
   callers keep working.
4. **Layering is unenforced, and three steps crossed it.** Fixed: pricing moves to
   `@vn/artgen`, `FILE_ROOTS` moves to `@vn/types`, and the git restorability check moves
   to the host and uses `git cat-file`. Imports are checked by hand; restoring enforcement
   is raised with the owner.
5. **Agent calls that delete a file were missed.** Fixed: `edit_scene` confirms whenever
   its plan removes a file, `ctx.confirm` carries the tool name, and new tools get
   `confirmDetail` cases. `story.mergeScene` and the line deletes join the uncommitted-
   project confirmation.
6. **Stage 8 steps that would fail.** Fixed: `asset.forget` clears the sheet directly;
   `.vnstudio/assetcheck.json` gets its own ignore line; the focus handler exists and is
   reused; the agent's git tools trigger the check; claims are one file each; the copied-
   folder case is stated; the re-appended record is the last `done` with that output.
7. **The validator wrote, and stale store instances could resurrect rows.** Fixed: a load
   path without `repairCurrent`; the desktop collector uses the session's store and
   reloads; other processes are a stated residual risk; the agent tool gets a `busy()`
   seam.
8. **Undecided details.** Fixed: severities are defined; "graph is gone" means the file is
   missing; entity-delete undo tests live in `apps/desktop/src/main/tests/`; stage 9's
   stop, no-remote and outcome shapes are stated; a project with no repository is treated
   like one the app does not own.
9. **Missing registration steps.** Fixed: the Delete shortcut, `REFETCHES_PROJECT`,
   `confirmDetail`, and the extra dead helpers in stage 0.
10. **Misstated facts.** Fixed: the `menuFor` form convention.
11. **Stage 2 was the hardest to undo**, because a minimal tombstone breaks older builds.
    Fixed: the tombstone is a requeue record plus `removed: true`. Stage 7 is irreversible
    for pictures not in git, which its check reports. Stage 8's `project_id` and claims
    format are lock-in across every project sharing `assets/`, which is accepted.
12. **Faithfulness to the decisions.**
    - "Any tool call that deletes a file": fixed by item 5.
    - "Orphaned takes are removed": concepts and uploads are still never collected,
      including those tied to a deleted character. They are authored sketches and uploads,
      which no slot claims by design (`apps/desktop/src/main/doctree/doctree.ts:327-330`).
      Kept as a deliberate narrowing; raised with the owner.
    - Removing base rows another project made went beyond the decision. Fixed: only base
      rows this project's task log produced are candidates.
    - "Undo after a collection": see item 1.
