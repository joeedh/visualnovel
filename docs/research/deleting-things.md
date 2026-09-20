# Deleting things

<!-- toc -->

- [Summary](#summary)
- [What exists today](#what-exists-today)
    - [Commands and rules that delete](#commands-and-rules-that-delete)
    - [Reachability of the existing deletes](#reachability-of-the-existing-deletes)
    - [Refusals that stand in for a delete](#refusals-that-stand-in-for-a-delete)
    - [Not deletable today](#not-deletable-today)
- [What references what](#what-references-what)
    - [Scenes](#scenes)
    - [Characters](#characters)
    - [Locations](#locations)
    - [Shots](#shots)
    - [Assets (slots and takes)](#assets-slots-and-takes)
    - [Wiki pages](#wiki-pages)
    - [Generation graphs](#generation-graphs)
    - [Threads and notifications](#threads-and-notifications)
    - [Skills and uploads](#skills-and-uploads)
- [The constraints a delete command runs under](#the-constraints-a-delete-command-runs-under)
    - [The `affects` vocabulary](#the-affects-vocabulary)
    - [Undo](#undo)
    - [Git](#git)
    - [Provenance](#provenance)
- [How the content-addressed layers behave when an input disappears](#how-the-content-addressed-layers-behave-when-an-input-disappears)
- [How `vnauthor` would expose a delete](#how-vnauthor-would-expose-a-delete)
- [The options](#the-options)
    - [(a) Hard delete of the authored file, with cascading cleanup of derived state](#a-hard-delete-of-the-authored-file-with-cascading-cleanup-of-derived-state)
    - [(b) Soft delete: a tombstone flag or a `trash/` directory, with a later purge](#b-soft-delete-a-tombstone-flag-or-a-trash-directory-with-a-later-purge)
    - [(c) Refuse unless unreferenced, with a "what references this" report](#c-refuse-unless-unreferenced-with-a-what-references-this-report)
    - [(d) Delete the authored input; treat derived state as orphaned; collect garbage separately](#d-delete-the-authored-input-treat-derived-state-as-orphaned-collect-garbage-separately)
    - [Comparison](#comparison)
- [Per-entity fit](#per-entity-fit)
- [Open questions for the owner](#open-questions-for-the-owner)

<!-- tocstop -->

A survey of the options for deleting project entities from the desktop app and from
`vnauthor`, written before any plan. It records what deletion support exists today, what
references each kind of entity, how the command system, undo, git and the
content-addressed stores constrain a delete, and four candidate designs with their
trade-offs. It ends with the questions the owner has to answer before a plan is written.
Nothing here is a decision.

Every claim about the code is cited as `path:line` against the `todos` worktree as of
2026-09-20.

## Summary

- Deletion exists today for scenes, shots, lines, choices, generation graphs, prompt
  references, notifications, plugins and saved layouts. It does not exist for characters,
  locations, wiki pages, skills, assets (bytes or manifest rows), threads, or uploaded
  originals. No code in the repository removes bytes from either asset root.
- The two existing entity deletes already embody two of the four options below.
  `story.deleteScene` refuses while a branch edge points at the scene (option c for edges)
  and leaves the scene's rendered frames and task records in place (option d for derived
  state). `story.deleteShot` and `gengraph.delete` are pure option d.
- Undo restores a deleted text document from an in-memory blob, but never a media file,
  and never anything under `vngen/build`, `vngen/state`, `assets/objects` or `keys`.
  Commit-on-save stages deletions with `git add -A`, so every hard delete of a tracked
  file is recoverable from git history whether or not undo covers it.
- The content-addressed task log is never pruned in production. A deleted input's tasks
  become orphans, and a restored input resurrects them by hash with no re-render. The
  planner reads `done` records without checking the bytes exist, so any garbage collector
  that removes bytes has to reconcile `tasks.jsonl` and both manifests in the same act or
  the next run fails reading a missing reference.
- The model build already tolerates every dangling reference a hard delete could create. A
  scene naming a deleted character gets a warning and loses that cast member; a scene
  naming a deleted location gets a mined stand-in with an empty description and a new
  plate hash; a branch edge to a deleted scene is an error. Only the branch edge is fatal.

## What exists today

### Commands and rules that delete

| Command                                                             | What is removed                                                                                                         | Refuses when                                                      | Undo | Confirm | Where                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------- |
| `story.deleteScene`                                                 | `scenes/<id>.md` and `vngen/work/shots/<id>.json`                                                                       | the scene is `start:`, or any `next`/choice edge points at it     | yes  | no      | `apps/desktop/src/main/commands/story.ts:425`, rule at `packages/scriptedit/src/lineops.ts:510` |
| `story.mergeScene`                                                  | the absorbed scene's chunk and storyboard                                                                               | the target does not continue to it, or anything else points at it | yes  | no      | `story.ts:468`, rule at `lineops.ts:597`                                                        |
| `story.deleteShot`                                                  | one shot from `work/shots/<scene>.json`; the file itself when it was the last shot                                      | no such shot                                                      | yes  | no      | `story.ts:610`, rule at `packages/scriptedit/src/shotcreate.ts:216`                             |
| `story.deleteLine`                                                  | one line; its id is retired and never reused                                                                            | see `lineops.ts:257`                                              | yes  | no      | `story.ts:316`                                                                                  |
| `story.removeChoice`                                                | one `[[choice:]]` marker line                                                                                           | no such index                                                     | yes  | no      | `story.ts:188`, rule at `packages/scriptedit/src/branchops.ts:72`                               |
| `gengraph.delete`                                                   | `vngen/work/graphs/<slug>.json`; the journal and blobs under `vngen/state/graphs/<slug>/` stay                          | no such graph                                                     | yes  | yes     | `apps/desktop/src/main/commands/gengraph.ts:354`, `packages/gengraph/src/document.ts:116`       |
| `gengraph.removeNode`, `gengraph.unlink`, `gengraph.removeBoundary` | one node, link or group socket inside a graph                                                                           | structural edit inside a group instance                           | yes  | no      | `gengraph.ts:446`, `:525`, `:1080`                                                              |
| `prompt.removeRef`                                                  | one pinned reference from a prompt clause                                                                               |                                                                   | yes  | no      | `apps/desktop/src/main/commands/prompt.ts:229`                                                  |
| `asset.unapprove`                                                   | approval only: `status:`/`approved_portrait:` on the sheet, `approved.png`, or the manifest `accepted` flag; bytes stay | see `previewUnapprove`                                            | no   | yes     | `apps/desktop/src/main/commands/asset.ts:158`, `packages/store/src/worktree.ts:132`             |
| `notify.deleteAll`                                                  | the whole `vngen/state/notifications.jsonl`                                                                             | the log is empty                                                  | no   | yes     | `apps/desktop/src/main/commands/notify.ts:97`                                                   |
| `plugin.remove`                                                     | an installed plugin directory under the user config dir                                                                 |                                                                   | no   | yes     | `apps/desktop/src/main/commands/plugin.ts:136`                                                  |
| `view.resetLayout`                                                  | with `all`, the author's saved layout templates                                                                         |                                                                   | yes  | no      | `apps/desktop/src/main/commands/view.ts:240`, `apps/desktop/src/main/workspace/layouts.ts:120`  |

Two facts about the existing rules matter for everything below.

- `story.deleteScene` computes its referrers from branch edges only
  (`packages/scriptedit/src/lineops.ts:139`): `next` and `choices` of every other scene,
  plus the entry check at `lineops.ts:513`. It does not consult notifications, threads,
  provenance, assets or the task log. The scene's frames stay in `vngen/build/assets/`,
  their manifest rows keep `satisfies: [{sceneId, shotId}]`, and their `done` records stay
  in `tasks.jsonl`.
- `story.deleteShot` names the cost in its own message: "Its rendered frame is orphaned —
  art that was paid for and will no longer be shown" (`shotcreate.ts:225`). The `nextShot`
  mark is carried so the freed id cannot be re-minted and inherit the dead shot's frame
  (`shotcreate.ts:241`). Removing the last shot deletes the file, which is the one signal
  meaning "decompose this scene again" (`shotcreate.ts:221`,
  `packages/store/src/shots.ts:290`).

The file removals themselves are `deleteSceneChunk` (`packages/store/src/scenes.ts:102`)
and `deleteShots` (`packages/store/src/shots.ts:295`), both plain `fs.rm`, both reported
back in `removed` and folded into the command's `written` list
(`packages/scriptedit/src/apply.ts:149`, `story.ts:113`) so provenance and undo see the
paths.

### Reachability of the existing deletes

- `story.deleteScene`: the Branch editor's toolbar and its selection panel
  (`apps/desktop/renderer/pathux/editors/branch.ts:360`, `:671`), the palette, CDP, and
  the agent's `edit_scene op=deleteScene` (`packages/authoring/src/tools/scenes.ts:287`).
  It is deliberately absent from the document tree's scene menu
  (`apps/desktop/renderer/pathux/doctree/doctree.ts:372`), and
  [`../reference/document-tree.md`](../reference/document-tree.md#deliberately-absent)
  lists "Moving and deleting through the tree" as a deliberate omission.
- `story.deleteShot`: the coverage timeline
  (`apps/desktop/renderer/pathux/interactions/timeline.ts:176`) and the agent's
  `edit_scene op=deleteShot` (`scenes.ts:348`), which also deletes the file when the op
  says to (`scenes.ts:351`).
- `gengraph.delete`: the tree's `graph` row (`doctree.ts:319`), as a form because it is
  `confirm: true`.

### Refusals that stand in for a delete

- `doc.write` refuses a save that drops a `type:` tag, with the sentence "that deletes the
  character, which is not an edit" (`packages/store/src/docfile.ts:239`). Removing the tag
  is the one way an author could today turn an entity sheet back into a wiki note, and it
  is refused from the Wiki pane and from the agent's `write_file`/`edit_file` alike.
- The agent's `write_file` refuses `characters/`, `locations/`, `scenes/` and graph paths
  by naming the tool that owns each (`packages/authoring/src/tools/files.ts:29`, `:56`),
  and no agent tool deletes a file. `git_restore` and `git_revert` are the only tools
  marked `confirm: true` (`packages/authoring/src/tools/git.ts:74`, `:86`); the
  `Tool.confirm` doc comment already lists "delete" among the acts the flag is for
  (`packages/authoring/src/tools/core.ts:127`).
- `AssetRoot`/`AssetStore` expose `write`, `read`, `accept` and `unaccept` and nothing
  that removes a row or a file (`packages/store/src/assetstore.ts:107`–`:203`,
  `:255`–`:310`). `packages/artgen/src/concept.ts:217` states it outright: "nothing in
  this repo removes bytes from the store".
  [`../reference/asset-stores.md`](../reference/asset-stores.md#what-this-does-not-do)
  lists "Collect garbage" as not done.

### Not deletable today

Characters, locations, wiki pages, skills, assets (any kind, bytes or rows), takes within
a slot, threads, uploaded originals under `archive/`, and layouts other than through the
reset. The document tree lists every one of these (`DocNodeKind`,
`apps/desktop/src/shared/ipc.ts:542`).

## What references what

The on-disk layout is `ProjectPaths` (`packages/store/src/paths.ts`). Authored input sits
at the root; `vngen/work/` is human-editable generated state; `vngen/build/` and
`vngen/state/` are machine output.

### Scenes

- Referenced by: other scenes' `next` and `choices[].goto`
  (`packages/types/src/entities.ts:359`), `start:` in `project.yaml`,
  `vngen/work/shots/<id>.json` (`paths.ts:126`), every `shot:<scene>/<shot>` slot address
  (`packages/artgen/src/slotaddr.ts:26`), manifest rows through `satisfies[].sceneId`
  (`entities.ts:388`), `shot_image` tasks in `tasks.jsonl`, `story.play.json`,
  notification links, thread transcripts and `commands.jsonl`.
- On a dangling reference: `dangling_goto` is an `error` diagnostic
  (`packages/model/src/build.ts:338`); `unknown_start` likewise (`build.ts:87`).

### Characters

- Referenced by: scene cast cues, resolved by name or id (`build.ts:191`); `[[outfit:]]`
  markers (`build.ts:220`); `ShotSubject.characterId` in every storyboard
  (`entities.ts:315`); `portrait:<id>` and `sheet:<id>/<outfit>/<angle>` slots
  (`slotaddr.ts:20`); manifest rows through `satisfies[].characterId`;
  `Character.approvedPortrait` written into the sheet's own front matter as
  `approved_portrait:` (`packages/store/src/worktree.ts:119`);
  `vngen/work/characters/<id>/{candidates,approved.png,outfits}` (`paths.ts:107`);
  portrait, sheet and shot tasks in `tasks.jsonl` (a shot's inputs embed the portrait
  hash, `packages/pipeline/src/planner.ts:353`); prompt-clause pins whose `from` binding
  names the character (`packages/types/src/prompt.ts:114`); wiki prose by mention only
  (there is no wiki-link syntax; `[[…]]` in this project is a Fountain marker vocabulary,
  `packages/model/src/scenes.ts:160`, and the bible index is an in-memory walk rebuilt per
  open, `packages/bible/src/indexer.ts:85`).
- On a dangling reference: `unknown_character` is a `warning` and the cue is dropped from
  `scene.characters` (`build.ts:203`); `unknown_outfit_character` drops the marker
  (`build.ts:227`). A shot whose subject has no character, or whose character has no
  approved portrait, is skipped by the planner without a diagnostic
  (`planner.ts:347`–`:374`), and by the slot graph with a `missing` sentence
  (`packages/artgen/src/slotgraph.ts:131`). The gate is unaffected because the deleted
  cast member is no longer in the scene's cast.
- A character's rendered art is not orphaned in the tree: `labelAssets` names an asset no
  entity claims by its hash (`document-tree.md:142`), and a picture no slot claims is
  listed beneath the slots of its kind (`apps/desktop/src/main/doctree/doctree.ts:302`).

### Locations

- Referenced by: every scene heading (`Scene.location`, `entities.ts:330`);
  `Shot.location` (a variant id, `entities.ts:252`); `plate:<loc>/<variant>` slots;
  manifest rows; every shot task in the scene (the plate hash leads the shot's `refs`,
  `planner.ts:332`); prompt pins.
- On a dangling reference: none. `mergeMinedLocations` synthesizes a location from the
  heading with an empty description (`build.ts:96`), so `unknown_location`
  (`build.ts:346`) fires only for a heading no scene reader produced. The consequence is
  that deleting a location sheet re-keys every plate under it (the prompt changes) and,
  one wave later, every shot in every scene set there. This is the one entity whose
  deletion silently costs money on the next run rather than reporting anything.

### Shots

- Referenced by: `shot:<scene>/<shot>` slots; manifest rows through `satisfies[].shotId`;
  `shot_image` tasks; `Shot.image` inside the storyboard itself (`entities.ts:295`); sheet
  groups (`Shot.sheet`, `entities.ts:287`); bound generation graphs; `story.play.json`.
- On removal: covered lines become gaps rather than being handed to a neighbour
  (`shotcreate.ts:222`); a page's panels and bubbles go with the shot.

### Assets (slots and takes)

- A slot is an address, not a record (`slotaddr.ts:17`); it exists as long as the model
  implies it (`slotgraph.ts:39`). A take is a manifest row plus a file, keyed by content
  hash.
- A take is referenced by: `Asset.refs` of every asset drawn from it (`entities.ts:401`);
  `TaskInputs.*.refs` of every task that used it (a shot's plate and portrait,
  `pipeline-contracts.md` "Content-addressed task graph"); `approved_portrait:` on a
  sheet; `Shot.image` in a storyboard; `ChunkRef.pin` in a prompt override
  (`prompt.ts:116`); the other root's manifest when adoption copied it across
  (`asset-stores.md`, "One hash then has two rows"); a gen-graph journal's `done` records;
  `story.play.json`; `vngen/state/reviews/<taskHash>`.
- Suspension is derived on read, never stored (`packages/artgen/src/suspend.ts:5`), so a
  reference to a removed hash produces no stored state to clean up, but `asset.suspended`
  and every prompt pane would report the pin as drifted.

### Wiki pages

- Referenced by nothing structural. `Bible.files()` walks the directory; a page is found
  by `bible.search`, not by backlink (`document-tree.md:229`). A tagged page under `wiki/`
  is an entity and has the references above.
- On removal: nothing dangles. `wiki/` may be its own repository
  (`../reference/repos-and-commits.md:31`), so a delete there commits in that repository.

### Generation graphs

- Referenced by: the slot each Output node binds (`gen-graphs.md`, "Slots and outputs"),
  reported on tree rows as `boundGraph`; group definitions under
  `vngen/work/graphs/lib/<ref>.json` referenced by every graph that instantiates them; the
  journal and blobs under `vngen/state/graphs/<slug>/`
  (`packages/gengraph/src/paths.ts:30`, `blobs.ts:10`).
- On removal (already shipped): the slot falls back to the planner's default path; the
  journal stays. Deleting a group definition that instances still reference is not covered
  by any command today.

### Threads and notifications

- Threads are `vngen/state/threads/<id>.jsonl` plus `<id>.native.jsonl`
  (`apps/desktop/src/main/notify/threads.ts:66`, `:457`). None of the six thread commands
  is undoable because `vngen/state` is outside the snapshot
  (`apps/desktop/src/main/commands/agent.ts:142`). Notifications link to a thread, an
  editor subject or a command by string; a link whose target is gone "reports that it went
  nowhere rather than refusing" (`notify.ts:127`).
- `commands.jsonl` records every command with `written` paths and git HEAD; deleting a
  thread removes the transcript but not the provenance records the thread's commands
  produced.

### Skills and uploads

- A skill is a directory under `.aiagent/skills/<id>/`; `project.yaml` may list builtin
  skill ids (`apps/desktop/src/main/commands/project.ts:170`). Nothing deletes one.
- Uploaded originals sit under `archive/`, outside every allow-list
  (`packages/authoring/src/archive.ts:4`), so nothing references them and nothing deletes
  them.

## The constraints a delete command runs under

### The `affects` vocabulary

- A mutating command declares the subtrees it may write, drawn from twelve directory roots
  and five files (`apps/desktop/src/shared/affects.ts:46`, `:62`). A cascade that touched
  `characters`, `scenes`, `vngen/work/shots`, `assets/manifest.json`,
  `vngen/build/manifest.json` and `vngen/state/tasks.jsonl` is declarable today
  (`asset.restore` already declares six roots, `asset.ts:137`).
- A command is `undoable` only when a snapshot holds something it writes
  (`affects.ts:116`); a command that reaches into excluded subtrees may still be undoable
  for the document half, which is what leaves `gate.approve` un-undoable because undo
  would roll back the sheet and leave the manifest (`command-system.md` "Only what a
  snapshot ... can restore is undoable").
- The executed tier of the `affects` test runs 59 commands over two testkit projects and
  fails on any path the declaration does not cover, so a delete command's cascade is
  measured, not trusted.

### Undo

- The snapshot store captures the document class as blobs in memory and restores by
  writing files whose hashes differ and removing paths the pre-tree recorded that the
  post-tree lacks (`packages/commands/src/content.ts:300`, `:361`). A deleted
  `character.md`, `scenes/<id>.md`, `wiki/**.md`, `work/shots/<id>.json` or
  `work/graphs/<slug>.json` therefore comes back on undo, bytes intact.
- Media is skipped at capture (`content.ts:45`, `:271`), so a deleted
  `characters/<id>/refs/*.png`, `vngen/work/characters/<id>/approved.png` or candidate PNG
  is not restored. `vngen/build`, `vngen/state`, `assets/objects`, `keys` and the session
  file are excluded outright (`affects.ts:26`), so no manifest row under `vngen/build`, no
  task record and no thread comes back either. `assets/manifest.json` is in the document
  class (it is not under `assets/objects`), so a base manifest edit is restorable while
  the bytes beside it are not.
- History lasts the session and holds fifty commands (`command-system.md` "History lasts
  the session"). A delete undone after a restart is a git operation.
- Undo refuses on drift: if a pipeline run rewrote `work/shots/<id>.json` after a delete,
  the undo is declined by name rather than guessed.

### Git

- The committer stages with `git add -A` (`packages/git/src/git.ts:172`, `:280`), so a
  deletion of a tracked file lands in the commit-on-save commit with the command's
  provenance trailer. Every hard delete of authored input is recoverable from history by
  the author, by the agent's `git_restore` (confirm-gated), or by `git checkout`.
- A project spanning repositories (`wiki/` or `assets/` as their own repos) commits per
  repository; a cascade that deletes from two repositories produces two commits.
- `vngen/` is committed in a real project (`CLAUDE.md`, "CLI"), so `tasks.jsonl` and both
  manifests are in history too. A garbage collector that rewrites them is a history event,
  not a cache flush.

### Provenance

- `commands.jsonl` is append-only and records `written` paths, git HEAD and dirty state. A
  delete leaves a record whose `written` names the removed paths (as `story.deleteScene`
  does now). A soft delete leaves the same record plus a file still on disk.
- `tasks.jsonl` is append-only and replayed last-writer-wins per hash
  (`packages/taskgraph/src/log.ts:17`). Nothing in production calls `TaskGraph.prune`
  (`packages/taskgraph/src/graph.ts:94`; the only callers are tests). The contracts doc
  says so and names the consequence: orphaned nodes accumulate, and both the failed-task
  requeue and the run report intersect with the planned set to avoid paying for art no
  plan asks for (`../reference/pipeline-contracts.md`, "Both the requeue and the report
  must intersect").
- A `done` record is the authority for whether work happened. `adoptSlot` is the one
  writer of a `done` record outside the scheduler, and the contracts doc treats a forged
  `done` as a provenance corruption. Removing a `done` record has no precedent and would
  be the mirror image: work that happened, reported as not having happened.

## How the content-addressed layers behave when an input disappears

- **Task identity is `sha256(kind, inputs)`** (`graph.ts:12`). The planner enumerates from
  the model each wave (`planner.ts:283`, `:313`), so a deleted scene, character or
  location simply produces no tasks. Its old nodes stay in the replayed graph as orphans,
  `done`, with their `output` hashes.
- **Dedupe resurrects.** Restoring the input (undo, `git restore`, retyping the same
  sheet) yields the same inputs, the same hash, and `loadGraph` hands the planner the old
  `done` record (`log.ts:20`). Nothing re-renders. This is the property that makes soft
  delete and hard-delete-plus-undo cheap, and it holds only while the bytes and the record
  both survive.
- **The planner trusts the log.** `doneOutput` returns a ref from `task.output` without
  checking either root (`planner.ts:229`). A downstream task then reads that ref through
  `store.read` (`packages/pipeline/src/genservices.ts:53`, `assetstore.ts:163`), which
  throws on a missing file. A collector that deletes bytes but leaves the record therefore
  breaks the next run at the first shot that references the collected plate or portrait.
  The same holds for `Character.approvedPortrait` and for every `ChunkRef.pin`.
- **Failure records are on orphans too.** `Task.error` and `attempts` live on the node. A
  deleted scene's `failed` shot stays `failed` in the log forever; the report ignores it
  because it is not planned, and `vngen status` counts it because status does not plan
  (contracts, "`vngen status` does not plan").
- **Storyboards drop dead line ids on read** (`packages/store/src/shots.ts:25`), and the
  planner logs a warning per dropped id (`planner.ts:99`). A scene whose storyboard names
  a deleted character keeps the subject; only the planner's `missingRef` skip applies.
- **Suspension is transitive and derived** (`suspend.ts:5`), so a deleted pin target is
  reported on the next read and clears when the pin moves; there is no stored cascade to
  run.
- **Gen-graph drift** is measured against the journal's last `done` record; deleting the
  graph document leaves the journal and the slot's last output where they are
  (`gengraph.ts:358`).

## How `vnauthor` would expose a delete

- Every tool is `mutating: true` or not, and plan mode dispatches only non-mutating tools
  (`packages/authoring/src/loop.ts:6`, `:990`). A delete tool is mutating, so it runs only
  inside an approved plan, and the plan's `files[]` list is where the author sees what
  will go before saying yes.
- `confirm: true` routes a tool through `Permission.confirmAction` regardless of mode
  (`loop.ts:1008`, `loop.ts:63`); the desktop wires that to a card in the conversation
  with a sentence from `confirmDetail` (`apps/desktop/src/main/session/core.ts:983`,
  `apps/desktop/src/main/agent/toolconfirm.ts:26`). `git_revert` and `git_restore` use it
  today; a delete tool would be the third.
- `approve_assets` is the model for an act whose authority must come from the author's own
  words: the host enumerates what is approvable, a small triage model reads only the
  author's turns (`ToolContext.said`, `packages/authoring/src/tools/core.ts:118`), and the
  author confirms the final list item by item (`packages/authoring/src/approve.ts:10`).
  The same three-check shape fits a bulk delete, and it is the only existing pattern that
  stops the agent from deciding mid-turn that the author wants something destructive.
- The agent's `edit_scene op=deleteScene` and `op=deleteShot` are not confirm-gated today
  (`scenes.ts:287`, `:348`); they rest on plan approval alone. Whether an entity delete
  should be held to the higher bar is an open question below.
- The agent does not reach the command registry (`command-system.md`, "From the agent"). A
  delete tool shares the rule with its `*.delete` command, exactly as `edit_scene` shares
  `lineops`. A "what references this" tool can be non-mutating and therefore usable in
  plan mode, which is where the agent would want it.
- `agent.run` declares `commitsItself`, so an agent-run delete commits once per approved
  plan rather than once per file.

## The options

The options are not mutually exclusive per entity. The per-entity table below pairs each
kind with the option that fits its reference shape.

### (a) Hard delete of the authored file, with cascading cleanup of derived state

- **What the author sees.** One act, one confirmation naming everything that goes: the
  sheet, its `work/` directory, its manifest rows, its bytes, its task records, and the
  storyboard subjects and prompt pins that named it. Afterwards the tree, the Assets
  branch, the Task Graph pane and `vngen status` agree that the entity never existed.
- **Commands and tools.** `character.delete`, `location.delete`, `wiki.delete`,
  `asset.delete` (one take) or `slot.delete` (every take of a slot), `thread.delete`,
  `skill.delete`, each `confirm: true` with a `check` that enumerates the cascade. Agent
  tools `delete_character` etc. sharing the same rule, `confirm: true`. Each cascade needs
  a new store primitive: `AssetRoot.remove(hash)` writing both the manifest and the file,
  and a `TaskGraph`/log operation that either appends a tombstone record or rewrites the
  log.
- **References.** Cascaded. Storyboards are rewritten to drop the subject (or the shot, if
  the subject was its only cast); scenes lose the cast cue only if the delete also edits
  prose, which crosses into `story.*`'s write path; prompt pins on other assets are
  dropped, which re-keys those assets' tasks and re-renders them on the next run.
- **Undo and git.** Text files come back on undo; media, manifest rows under
  `vngen/build`, task records and threads do not. A partially-undoable command is the
  `gate.approve` case the undo plan left out, so the command would be `undoable: false`
  and rely on git. A cascade across two repositories (`assets/` as its own repo) is two
  commits.
- **Content-addressed store.** Bytes are removed. The `done` record for the removed take
  must go too, or the next run fails reading it (`planner.ts:229` → `assetstore.ts:163`).
  A hash shared by two slots (dedupe collapses identical work, `graph.ts:12`) must not be
  removed while another slot still resolves to it, so `remove` needs a reference count
  over `satisfies` plus every `refs` list, or the cascade corrupts a survivor.
- **Provenance risk.** Highest. `tasks.jsonl` has no precedent for removing a `done`
  record; rewriting an append-only log is the kind of act the contracts doc lists failures
  for. `commands.jsonl` keeps the record, so the act is auditable, but the state it
  describes is gone.
- **Cost.** Highest. A store `remove`, a log tombstone or rewrite, a reference counter, a
  cascade planner per entity kind, `affects` declarations spanning most of the vocabulary,
  the executed-tier fixtures for each, and the same rule exposed as an agent tool. Roughly
  the size of the adoption plan plus the undo plan.

### (b) Soft delete: a tombstone flag or a `trash/` directory, with a later purge

Two sub-shapes:

- **Flag.** A `deleted: true` key in front matter (entities, wiki) or a `deleted` field in
  a storyboard row or manifest row. Every reader filters it. The document tree draws a
  "Deleted" branch, or hides the row behind a filter.
- **Move.** The file moves to `trash/<original path>` (a new `affects` root). Entity
  discovery walks three places only (`characters/`, `locations/`, `wiki/**`,
  `pipeline-contracts.md` "An entity is found by its tag"), so a moved sheet simply leaves
  the model; the tree can list `trash/` as the file tree already lists everything. A
  variant for entities is dropping the `type:` tag (the move the `doc.write` refusal at
  `docfile.ts:239` currently forbids), which turns a sheet into a wiki note in place.

- **What the author sees.** Delete is reversible from the app without git. A restore
  command puts the row or file back. A purge command, confirm-gated, makes it option (a)
  or (d) later.
- **Commands and tools.** `<kind>.delete` (mutating, undoable, no confirm needed since it
  is reversible), `<kind>.restore`, `trash.purge` (confirm). Agent tools mirror the first
  two; purge can stay app-only, like `story.decomposeAll` is today.
- **References.** Dangling, in the same way a hard delete leaves them, because the model
  no longer contains the entity either way. The flag shape has one advantage: a reader
  that wants to can still resolve a tombstoned id (for the tree's asset labels, for a "was
  deleted" badge on a storyboard subject) rather than showing `hash8.png`.
- **Undo and git.** Fully undoable for the flag and for a move within the document class
  (a move is a delete plus a create in snapshot terms, and both are restorable). Git sees
  a rename or a one-line edit. A purge inherits the undo story of whatever it does.
- **Content-addressed store.** Untouched until purge. Dedupe keeps working: an un-deleted
  entity's tasks are still `done`. This is the option under which "restore" costs nothing.
- **Provenance risk.** Lowest. Nothing append-only is rewritten. The cost is that every
  reader has to honour the tombstone, and a reader that does not (the exporter,
  `vngen cost`, `buildSlotGraph`, the bible walk for a tagged page in `trash/`) is a bug
  that shows a deleted thing as live. A flag inside `scenes/<id>.md` front matter
  conflicts with the closed scene schema ("`scene: <id>` and nothing else", contracts), so
  scenes would take the move shape.
- **Cost.** Moderate. No store or log primitives. The `trash/` root is one line in
  `affects.ts:46`. The filtering is spread across every enumerator, which is the same set
  `used.ts` was lifted for
  (`reachableScenes`/`allCharacters`/`usedOutfits`/`allLocationVariants`), so it is a
  known list. The purge is deferred work and could be option (d)'s collector.

### (c) Refuse unless unreferenced, with a "what references this" report

- **What the author sees.** Delete is offered everywhere but refuses by name while
  anything points at the target, as `story.deleteScene` does now for edges
  (`lineops.ts:517`): "arrival (next), greet (choice 0) still point at rooftop". The
  report lists scenes casting a character, shots casting it, pins referencing its art,
  threads mentioning it, and the count of takes and tasks that would be orphaned. The
  author removes the references by hand (or with the agent, which is the workflow
  `story.setHeading` already names) and then deletes.
- **Commands and tools.** `<kind>.delete` with a `check` whose refusal is the report;
  `<kind>.references` (non-mutating) so the palette, CDP and the agent can read the report
  without attempting the delete. A `references` tool is usable in plan mode, which lets
  the agent plan the un-referencing edits before proposing the delete.
- **References.** Refused rather than dangled or cascaded. The delete itself then has
  nothing to cascade except derived state (which is option (d)'s question). Which
  references count is a decision: branch edges are fatal; a cast cue is a warning; a
  manifest row or a task record is neither. Counting only what the model build would
  report as `error` matches the existing scene rule; counting warnings too means a
  character can never be deleted while a scene mentions it, which is most characters.
- **Undo and git.** Same as a plain file delete: text comes back on undo, and the delete
  is one commit. Because the delete runs only when unreferenced, undoing it cannot
  re-dangle anything.
- **Content-addressed store.** Untouched. Orphaned takes and tasks are option (d)'s
  problem and stay cheap to keep.
- **Provenance risk.** Low. The only write is the file removal.
- **Cost.** Low to moderate. A reference walker over the model, the storyboards, the
  manifest and prompt overrides is the same walk `buildDocTree` and `EntityLinks` already
  do (`document-tree.md:210`), so most of it exists as `backlinks`. What is new is the
  threads and notifications scan, if those count, and the per-kind `check` wording. Every
  delete command is a thin wrapper, like the existing ones.

### (d) Delete the authored input; treat derived state as orphaned; collect garbage separately

- **What the author sees.** A delete removes the file and nothing else, as
  `story.deleteScene` and `gengraph.delete` do today. Orphaned takes stay visible in the
  Assets branch under a hash name (`doctree.ts:302`, `document-tree.md:142`) and orphaned
  tasks stay in `vngen status`. A separate `store.gc` (or `project.collect`) command,
  confirm-gated, reports and then removes what no plan, no slot, no pin and no sheet
  references.
- **Commands and tools.** `<kind>.delete` per kind, each as thin as `story.deleteScene`;
  one `store.gc` with a `--dry-run`-style `check` that prints the list and the byte total.
  The agent gets the deletes; whether it gets `store.gc` is an open question (it is the
  one command that destroys paid-for bytes).
- **References.** Dangling, tolerated by the model build as documented above. The visible
  costs: a deleted location's plates and every shot set there re-key and re-render on the
  next run with no warning; a deleted character's shots are silently skipped by the
  planner; prompt pins on a removed hash read as suspended.
- **Undo and git.** Each delete is undoable for its text file and is one commit. Restoring
  the file resurrects its tasks by hash with no re-render, as long as `store.gc` has not
  run in between. `store.gc` is not undoable (bytes and log records are outside the
  snapshot) and relies on git for the manifests and the log, and on nothing for the bytes
  if `assets/objects` is not committed.
- **Content-addressed store.** Orphans are cheap to keep: bytes are stored once per root
  and nothing reads an unplanned task. The collector's rule has to be "unreachable from
  every live root", where the roots are: every slot the current model implies
  (`buildSlotGraph`), every `approvedPortrait`, every `Shot.image`, every `ChunkRef.pin`,
  every `Asset.refs` entry of a kept asset, every gen-graph journal output, and every
  concept and upload (which no slot claims and must never be collected on that ground,
  `doctree.ts:302`). The collector must write the manifest, the files and a `tasks.jsonl`
  tombstone in one act, for the `planner.ts:229` reason; a partial collection is the
  failure mode.
- **Provenance risk.** Low for the deletes, moderate for the collector. The collector is
  the first production caller of anything like `TaskGraph.prune`, and the contracts doc's
  warning about a blind sweep ("either pay again for art that no plan asks for or leave
  the exit code failing forever") is the exact bug a wrong reachability rule produces.
- **Cost.** Lowest for the deletes: each is `story.deleteScene` with a different file. The
  collector is a separate, bounded piece of work whose reachability walk reuses
  `buildSlotGraph` and `suspendedAssets`, and it can ship later or never.

### Comparison

| Concern                  | (a) Hard + cascade                 | (b) Soft / trash                           | (c) Refuse + report                          | (d) Delete input, GC later                       |
| ------------------------ | ---------------------------------- | ------------------------------------------ | -------------------------------------------- | ------------------------------------------------ |
| Author's mental model    | gone, everywhere, at once          | gone from the story, still on disk         | cannot go until nothing needs it             | gone from the story; art lingers until collected |
| New store/log primitives | `remove`, tombstone, refcount      | none (until purge)                         | none                                         | none for deletes; all of (a)'s for the collector |
| Dangling references      | cascaded (re-renders neighbours)   | dangling, resolvable through the tombstone | prevented                                    | dangling, tolerated                              |
| Undo                     | partial; must be `undoable: false` | full                                       | full for the file                            | full for the file; none for the collector        |
| Git                      | one commit per repo touched        | rename or one-line edit                    | one file                                     | one file; collector commits manifests and log    |
| Resurrection by dedupe   | lost (records removed)             | free                                       | free                                         | free until collected                             |
| Provenance risk          | high                               | low                                        | low                                          | low / moderate                                   |
| Readers that must change | none                               | every enumerator                           | none                                         | none                                             |
| Implementation cost      | high                               | moderate                                   | low–moderate                                 | low, plus a deferrable collector                 |
| Precedent in the repo    | none                               | `notify.hide` (flag, `notify.ts:50`)       | `story.deleteScene` edges (`lineops.ts:517`) | `story.deleteShot`, `gengraph.delete`            |

## Per-entity fit

| Entity           | Lives at                                                                                             | Referenced by                                                                                                                                     | Fits best  | Why                                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scene            | `scenes/<id>.md`, `vngen/work/shots/<id>.json`                                                       | branch edges, `start:`, storyboard, shot slots, manifest rows, tasks, playable                                                                    | (c)+(d)    | Shipped. Edges are fatal so they are refused; frames and tasks are orphaned. The only gap is the missing tree menu entry and, optionally, listing the orphaned takes in the check's note.                                                                                                        |
| Shot             | one row in `vngen/work/shots/<scene>.json`                                                           | shot slot, manifest row, task, `Shot.image`, sheet group, bound graph                                                                             | (d)        | Shipped. The message already names the orphaned frame. A shot in a sheet group re-keys every member (contracts, "A staging sheet is in every member's identity"), which the check could say.                                                                                                     |
| Character        | `characters/<id>/character.md` or a tagged wiki page; `vngen/work/characters/<id>/`; base-root takes | cast cues (warning), `[[outfit:]]` (warning), storyboard subjects (silent skip), portrait/sheet slots, `approved_portrait:`, shot task refs, pins | (c) or (b) | Deleting a cast member silently un-plans every shot casting them, which is a cost the author should see; a report is the cheapest way to show it. The `type:`-tag variant of (b) is already the refusal at `docfile.ts:239`, so soft delete is a one-line policy change on a writer that exists. |
| Location         | `locations/<id>.md` or a tagged wiki page; base-root plates                                          | every scene heading (mined stand-in, no diagnostic), `Shot.location`, plate slots, every shot task in those scenes, pins                          | (c)        | The one delete that silently re-renders on the next run (`build.ts:96` synthesizes a stand-in with a different prompt). A refusal that counts scenes set there prevents an unpriced re-render; (d) would have to price it in the check instead.                                                  |
| Wiki page        | `wiki/**/*.md`, possibly its own repo                                                                | nothing structural (search only)                                                                                                                  | (d)        | No references to refuse on and no derived state to collect. A tagged page is an entity and takes that entity's option instead.                                                                                                                                                                   |
| Asset take       | `assets/objects/` or `vngen/build/assets/` plus a manifest row                                       | `Asset.refs`, task `refs`, `approved_portrait:`, `Shot.image`, pins, the other root's copy, journals                                              | (d)        | Removing one take is what the collector does with a reference walk; doing it per take by hand needs the same walk plus a refcount, which is (a). `asset.unapprove` already covers "stop using this take" without removing it.                                                                    |
| Asset slot       | an address; takes as above                                                                           | the model (it exists while implied)                                                                                                               | none       | A slot cannot be deleted directly; it disappears when the entity or shot implying it does. "Delete all takes of a slot" is the collector scoped to one address.                                                                                                                                  |
| Gen graph        | `vngen/work/graphs/<slug>.json`; journal under `vngen/state/graphs/<slug>/`                          | the slot it binds; group definitions it instantiates                                                                                              | (d)        | Shipped. A group definition in `lib/` with live instances is the one unhandled case and fits (c).                                                                                                                                                                                                |
| Thread           | `vngen/state/threads/<id>.jsonl`, `<id>.native.jsonl`                                                | notification links (tolerated), `commands.jsonl` records (kept)                                                                                   | (d) or (b) | Outside undo either way. A `hidden` flag mirrors `notify.hide` and keeps the transcript for review skills; a file delete is a `notify.deleteAll`-shaped confirm command.                                                                                                                         |
| Notification     | rows in `vngen/state/notifications.jsonl`                                                            | nothing                                                                                                                                           | (b)        | Shipped as `notify.hide`/`notify.deleteAll`.                                                                                                                                                                                                                                                     |
| Skill            | `.aiagent/skills/<id>/` (project), or user/builtin tiers                                             | `project.yaml` builtin list; the agent's `discover_skills`                                                                                        | (d)        | A directory delete; the tree's Skills branch and `project.yaml` re-read. The user and builtin tiers are outside the workspace and take `plugin.remove`'s shape.                                                                                                                                  |
| Upload (archive) | `archive/<batch>/<file>`                                                                             | nothing (outside every index)                                                                                                                     | (d)        | Nothing references it; `MAX_UPLOAD_BYTES` (`archive.ts:28`) is the reason an author would want to.                                                                                                                                                                                               |
| Line, choice     | inside a scene chunk                                                                                 | shots (coverage), edges                                                                                                                           | shipped    | `story.deleteLine`, `story.removeChoice`.                                                                                                                                                                                                                                                        |

## Open questions for the owner

- **Which references count as blocking?** `story.deleteScene` refuses on what the model
  build reports as an `error`. For a character, the build reports a `warning` and drops
  the cue. Refusing on warnings means most characters cannot be deleted without editing
  prose first; not refusing means the planner silently skips their shots. Is the check's
  note (cost shown, delete allowed) enough, as `story.setHeading` decided for its
  restaging cost?
- **Should deleting a location be allowed to re-key every shot set there without a
  confirmation?** Today nothing in the model reports it. `story.setHeading` shows the cost
  in its check rather than confirming; `project.setArtStyle` confirms because it reaches
  every image. Which precedent applies?
- **Is derived state ever removed, and by what?** Keeping orphans is free and is the
  current policy for shots and graphs. If a collector is wanted, is it a command an author
  runs, a step inside `pipeline.run`, or a CLI-only tool? Does the agent get it?
- **Does the collector rewrite `tasks.jsonl`, append tombstones, or leave it alone and
  only remove bytes and manifest rows?** Leaving it alone breaks the planner at
  `planner.ts:229` for any collected hash a surviving task references, so "leave it alone"
  only works if the reachability rule is "referenced by any record in the log", which
  collects almost nothing.
- **Soft delete for entities: flag, move, or tag removal?** Tag removal is the only shape
  that needs no new reader logic (the sheet becomes a note), but it also means the file
  keeps its path and its `id:`, and re-adding the tag is the restore. Is that acceptable,
  or is a visible `trash/` wanted?
- **Which deletes does the agent get, and at which bar?** `edit_scene op=deleteScene` runs
  on plan approval alone. Options are: the same for every entity; `confirm: true` for
  entities and takes; or the `approve_assets` three-check shape for anything that removes
  paid-for art. The desktop's `requestConfirm` card and the triage model both exist.
- **Should a delete appear in the document tree's right-click menu?** `document-tree.md`
  lists it as deliberately absent, and the branch editor and timeline own the two shipped
  deletes. Adding "Delete…" as a `form: true` entry (as `gengraph.delete` already is on
  graph rows) is one line per kind in `menuFor`, but it reverses a recorded decision.
- **What happens to `work/characters/<id>/` and `work/locations/<id>/` on an entity
  delete?** They hold candidate PNGs, `approved.png` and breakdowns; they are generated,
  under `vngen/work` (snapshotted as text, but the PNGs are media and are not restored).
  Delete with the sheet, leave for the collector, or leave forever?
- **Do threads and notifications count as references?** They mention ids as text. Scanning
  them for the report is cheap; refusing on them is unworkable; showing them is a choice.
- **Is a purge ever undoable, and what does undo mean after a collector runs?** Undo of a
  delete restores the file; the file's tasks resurrect by hash only if their bytes
  survived. Should the collector refuse while any snapshot in the undo journal still
  references a hash it would collect, or should undo report the missing bytes as it
  reports a missing snapshot?
- **Does `assets/` as its own repository change the answer for takes?** A base-root delete
  is a commit in a repository that may be shared between projects; a collector run from
  one project could remove a plate another project's manifest names. Is sharing a real
  use, or is the second repository only a provenance boundary?
