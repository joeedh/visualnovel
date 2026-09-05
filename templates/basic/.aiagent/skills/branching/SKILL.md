---
name: Branch the Story
description:
    Playbook for forking a route, splitting a shared scene per route, and proving every
    route still reaches an ending.
when-to-use:
    The user wants a choice, a branch, a route, an alternate path, or prose that should
    read differently depending on what the reader chose.
---

# Branch the Story

Branching is **scene-granular and there is nothing finer**. Two readers on two routes read
the same scene file byte for byte, or they read different scenes. Everything below is how
to turn "this should feel different on the Ember path" into scenes that actually do.

## 1. Pick the shape, and say what it costs

Three shapes cover almost everything. Name the one you are proposing and how many new
scenes it is before writing any of them — the author is choosing how much of the story
doubles.

- **One trunk, a late fork.** Every route reads the same scenes until near the end, then
  splits and never rejoins. Cheapest: one new scene per ending.
- **An early fork that reconverges.** The routes split at the choice, run for a few beats
  each, then `[[next:]]` back into a shared scene. Costs one scene per route per diverging
  beat. This is usually the right answer when the author says "it should feel different
  for a while".
- **Fully separate routes.** Everything after the fork is per-route. Costs the rest of the
  story, once per route. Propose it only when the author asks for it in those terms.

## 2. Split a shared scene into per-route chunks

When an existing scene should read differently per route:

1. `parse_fountain` the scene to see its line ids, choices and `next`.
2. `newScene` (via `edit_scene`) one chunk per route, with the same heading unless the
   routes are in different places. Name them `<route>_<beat>` — `em_landing`, `wr_truth`.
   **A scene id cannot be changed afterwards**: an id is derived from a name once, at
   creation, and a rename is not a thing scenes have. Get it right the first time.
3. Move the prose: `insertLines` the per-route version into each new chunk, then
   `deleteLines` from the original what no route reads any more. Batch both — a scene
   rewritten one line at a time costs forty calls.
4. Wire the fork: one `[[choice: "…" -> <scene>]]` per option on the scene the reader
   chooses from, via `edit_branches`.
5. Wire the rejoin: `[[next: <scene>]]` on the last scene of each route, pointing at the
   shared scene the routes reconverge into. **This is the step that gets skipped.**
   `newScene` leaves a scene unreachable and going nowhere until it is wired.
6. `story_graph`, and read it. Every route must reach an ending, and nothing may be
   orphaned. `unreachable_scene` is a **warning** — it will not block your commit, so the
   graph is the only thing that will tell you.
7. `validate_inputs`, then commit once:
   `Fork the rooftop scene into the Ember and Wren routes`.

## 3. What to refuse, and what to offer instead

The format has no variables, flags, counters, conditionals, or per-route variants of a
line. When the author asks for something that would need one, say so plainly and propose
the split:

> The format has no conditionals — prose that varies has to be a different scene. I can
> split the rooftop scene into `em_rooftop` and `wr_rooftop` and rejoin at `dawn`; that is
> two new scenes.

Never label prose with the route it belongs to. `(Ember path) she hesitates` is a
well-formed action line, nothing rejects it, and it is read aloud to **every** reader on
**every** route. There is no notation to invent here: a split or nothing.
