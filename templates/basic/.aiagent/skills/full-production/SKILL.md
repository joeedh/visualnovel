---
name: Full Production Pass
description: The whole route from a one-line premise to a storyboarded project — bible, characters, outline, treatment, scenes, scripts, locations, then the hand-off to decomposition.
when-to-use: The user has a premise and wants a whole VN built, or asks what order to do things in. Also when picking a half-built project back up — start at the first phase whose output is missing.
---

# Full Production Pass

Nine phases, in order. **Each phase is its own plan, its own approval and its own commit** — this
is far too much work for one turn, and an author who stops after phase 4 must be left with
something coherent. Never propose two phases in one plan.

Before starting anything, run `list_workspace` and `story_graph`: a project that already has
characters and scenes is a project you **resume**, not one you begin. Say which phase you are
starting at and why.

## Phase 1 — the world

`write_file wiki/world.md`. Setting, era, technology or magic, the rules that constrain plot,
tone, and the visual register the art should hit.

The bible is **reached by query, never pasted** — `search_bible` retrieves passages, and nothing
ever hands the model the whole file. So write for retrieval: short `##` sections, each headed with
the words someone would search for (`## Currency`, not `## Some economics`), and every section
self-contained enough to answer on its own.

## Phase 2 — the factions

`write_file wiki/factions.md`, or one page per faction under `wiki/factions/` once there are more
than about four. Each faction gets: what it wants, what it will not do to get it, who leads it,
and how a stranger recognizes a member on sight — that last one is what the art pipeline can use.

## Phase 3 — the characters

One `create_character` call per character, filling every field you know in the same call rather
than creating and then editing. Defer to the **Add a Character** skill for the field-level rules
(`discover_skills`, then `run_skill`); do not restate them here.

Two things this phase owns that that skill does not:

- **Cast size is a budget.** Every character with a speaking line eventually needs an approved
  portrait and a model sheet per outfit before any shot they stand in can render. Six named
  speakers is a project; twenty is a bill. Say the number out loud in the plan.
- **Tie each one to phase 2** — name their faction in the body, so `search_bible` connects them.

Leave `status: draft`. Approval is the author's act, never yours.

## Phase 4 — the outline

`write_file wiki/outline.md`. The branch structure, as a list of scene ids with the choices between
them: which scene each choice leads to, where paths rejoin, and every ending. Ids here are the ids
phase 6 will create, so settle them now — a scene is deliberately **not renamable**.

Keep the branching honest: a choice that rejoins two beats later is a flavour choice, and three of
those cost less than one real fork. Mark which is which.

## Phase 5 — the treatment

`write_file wiki/treatment.md`. A paragraph per scene, in outline order: who is present, what
changes, what the reader learns, and what the scene must set up for later. This is the last place
prose is cheap to rewrite, so this is where the author should be pushed to argue with you.

## Phase 6 — the breakdown

`write_file wiki/breakdown.md` — one **table row** per scene: id, heading, location id, cast,
line-count estimate, and the branch it sits on. One file, not one per scene: this is the checklist
phases 7–9 are read against, and it is the thing to update when something moves.

## Phase 7 — the scenes, headed and wired

For each row: `edit_scene op=newScene scene=<id> heading=<INT. CLASSROOM - EVENING>`.

- **The heading carries the location**, so get it right now. Changing it later with `setHeading`
  re-renders the scene and restages every shot in it — that is a re-render bill, not an edit.
- `newScene` leaves the scene **unreachable on purpose**. Follow the whole batch with
  `edit_branches` (`setChoice`, `setNext`) to wire the graph from phase 4, then `story_graph` to
  prove nothing is orphaned and every path reaches an ending.

Commit with the graph wired. A batch of unreachable scenes is not a resting point.

## Phase 8 — the scripts

Scene by scene, `edit_scene op=insertLines` — **one call per run of prose**, never forty
`insertLine` calls. Work in the order paths branch, so an author reviewing can read a whole route.

Ids are allocated for you and reading never writes. Keep each scene inside what the treatment said
it does; if the scene wants to grow past that, say so and update `wiki/treatment.md` in the same
plan rather than letting the two disagree.

## Phase 9 — the locations

Now, not earlier: run `extract_entities` over the finished scenes so the list comes from what the
prose actually names, then `create_location` for every one that has no sheet — filling every field
in the one call. A location's body is read verbatim by the image model, so describe the **place**
(light, materials, scale, what is in frame), and let variants carry time of day.

Cross-check against phase 6's table and report any location a scene heading names that nothing
created.

Finish with `validate_inputs`, then commit.

## The hand-off — shots

**You cannot make shots.** Decomposition is a pipeline step: the author runs **Decompose All
Scenes** in the app (`story.decomposeAll`) or a `vngen run`. It is an explicit act because an
absent `vngen/work/shots/<sceneId>.json` is the only signal meaning "decompose this", and a
decomposition, once written, wins forever.

So end phase 9 by saying exactly that, and stop. Once the author has run it, you can work on the
storyboard:

- **Read it first.** Coverage is what to check: every line covered by exactly one shot, no shot
  with no lines. A shot with no lines never appears; a line with no shot leaves the previous image
  on screen.
- **Framing is the decomposer's choice, not yours** — you cannot set `framing` or `subjects`. What
  you can do is `set_art_notes rung=shot:<sceneId>/<shotId>` to direct a frame ("the speaker in the
  near third, listener over-shoulder"), `set_outfit shot=…`, and `edit_scene op=moveShot` to
  reorder, which moves the lines the shot covers.
- Art notes are **appended** to the derived prompt and **re-render** the frames they reach. Say how
  many pictures a proposal re-draws before proposing it.
