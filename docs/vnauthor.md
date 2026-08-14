# `vnauthor` — the authoring agent

A plan-first, git-backed conversational agent that helps an author write and refine the inputs
the pipeline consumes. It does **not** run the generative pipeline — it stops at well-formed,
validated input files in a clean commit. Design:
[`authoring-agent-report.md`](authoring-agent-report.md); plan:
[`plans/authoring-agent-implementation.md`](plans/authoring-agent-implementation.md).

<!-- toc -->

- [Running it](#running-it)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Skills](#skills)

<!-- tocstop -->

## Running it

```
vnauthor [dir] [--mock] [--native]
```

- `--mock` runs offline with no model (read-only smoke test — exercises workspace/skill loading
  and the REPL without API keys).
- `--native` uses provider-native function-calling (Path B) when the configured model supports
  `chatWithTools`; otherwise the agent falls back to structured ReAct (Path A).
- Model + keys resolve exactly like `vngen`: `models.text` in `project.yaml`, key via env var or
  a secret file under `<dir>/keys/` (falling back to a shared `keys/` at the enclosing repo
  root).

REPL commands: `/help`, `/mode` (plan vs. execute), `/model [id]` (switch the text model; no arg
→ interactive menu), `/effort [level]` (set reasoning effort — `low`…`max` map to Anthropic
`output_config.effort` + adaptive thinking, ignored on models that don't support it; no arg →
interactive menu), `/clear` (reset the conversation context, back to plan mode), `/status`
(project index), `/skills` (available skills), `/exit` (or `/quit`). **Shift-Tab** cycles
between plan and execute mode. `/model` and `/effort` rebuild the backend and hot-swap it into
the running agent, preserving conversation state.

Offline smoke test:

```sh
pnpm build
printf '/skills\n/status\n/exit\n' | node apps/authoring/dist/vnauthor.js examples/sample --mock
```

[`examples/sample/AICONTEXT.md`](../examples/sample/AICONTEXT.md) shows project guidance the
agent honors.

## How it works

- **Two-mode state machine (`@vn/authoring` `loop.ts`).** The agent starts in **plan mode
  (read-only)**: only non-mutating tools dispatch; any mutating tool is blocked until the user
  approves a proposed plan. Approving a plan switches to **execute mode**, where edits apply,
  `validate_inputs` runs, and `git_commit` is **blocked while error-severity diagnostics remain**
  (soft/style issues only warn). One commit per approved plan.
- **Always-confirm.** `git_revert`/`git_restore` and the first run of a script-bearing skill
  route through the permission gate regardless of mode.
- **Agent backend seam.** The loop targets an internal `AgentBackend`; `StructuredAgentBackend`
  (Path A) drives tools as zod-validated JSON over the text seam, `NativeAgentBackend` (Path B)
  drives them through the vendor tool protocol. The loop is the arg-validation authority, so
  Path B advertises permissive tool params and re-validates via the registry.
- **Context precedence:** built-in input contract > `AICONTEXT.md` (+ nested per-dir files and
  `@import` lines; `AGENTS.md`/`CLAUDE.md` as fallbacks) > `AICONTEXT.generated.md` (the project
  map) > inferred defaults. `update_context` turns a chat instruction into a durable line in
  `AICONTEXT.md`; `regenerate_context` rebuilds the map. The map states facts and the author states
  policy, so the author wins — the two are separately labelled sections of the system message, and
  a file at the generated path without the generator's banner is ignored rather than trusted.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `applyCharacterEdit` /
  `applyLocationEdit` serializers (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed front-matter
  so untouched prose and branch markers are preserved.
- **Prose edits are the desktop's edits.** `edit_scene` names the same ten acts the `story.*`
  commands do — and `set_outfit` the two outfit commands — running the same `@vn/scriptedit`
  decisions, so a refusal an author sees mid-drag is the refusal the agent gets, and the storyboard
  consequence is accounted for once. See
  [`command-system.md`](command-system.md#from-the-agent).

## Tools

The registry is `packages/authoring/src/tools.ts` — 25 tools. **M** marks `mutating: true`
(blocked in plan mode); **C** marks `confirm: true` (always through the permission gate,
whatever the mode).

| Group | Tools |
| ----- | ----- |
| Read & search | `read_file`, `list_workspace`, `search`, `search_bible` |
| Domain & validation | `validate_inputs`, `parse_fountain`, `story_graph`, `extract_entities` |
| Entity editing | `create_character` **M**, `create_location` **M**, `edit_character` **M**, `edit_location` **M** |
| Scene prose | `edit_scene` **M** |
| Wardrobe | `set_outfit` **M** |
| Raw write | `write_file` **M** |
| Context | `update_context` **M**, `regenerate_context` **M** |
| Git (read) | `git_status`, `git_log`, `git_show`, `git_diff` |
| Git (write) | `git_commit` **M**, `git_init` **M**, `git_revert` **M C**, `git_restore` **M C** |
| Skills | `discover_skills`, `run_skill` **M** (**C** on the first run of a script-bearing skill) |

Two absences are deliberate. **Editing is typed per entity** rather than a generic
`edit_file`: `edit_character`/`edit_location` route through `@vn/model`'s serializers, so the
round-trip guarantee holds by construction and `write_file` stays the escape hatch for files
with no schema. Both edit tools patch the sheet the workspace index actually loaded — a character
tagged `type: character` under `wiki/` is edited where it lives, never at the conventional path —
while the `create_*` tools do write to the conventional directory, because that is where a sheet
that does not exist yet goes. But **not for scenes**: `write_file` refuses a `scenes/` path outright and names
`edit_scene` instead, because a chunk written whole is a chunk with no proof: duplicate line ids, a
lost heading, a scene id that stopped matching its filename, and stranded storyboards, none of which
anything downstream would notice. And **nothing lets the model change its own mode** — there is no
`enter_plan_mode`/`exit_plan_mode` tool. Mode is owned by the REPL and the permission gate,
which is what makes plan mode a guarantee rather than a request.

`set_outfit` is **one tool for both levels** of the outfit chain, because they are one authorial
sentence: "put Aiko in her tracksuit for the club scene" and "…for this one frame" differ by a
word, and which file the change lands in is a consequence rather than a choice the author makes.
The `shot` argument picks the level — absent, a `[[outfit:]]` marker is spliced into the scene
chunk; present, the subject's override is written to `work/shots/<sceneId>.json`, which re-hashes
that shot. `outfit=""` clears either and lets the level below answer. The wardrobe itself is
authored on the character sheet (`edit_character`'s `outfits` / `defaultOutfit`), so the set
`set_outfit` will accept is the set the sheet declares.

`regenerate_context` writes the **project map**, `AICONTEXT.generated.md`: the cast with each
sheet's path and wardrobe, the locations and their variants, the story graph, and the story
bible's table of contents — one line per note, its path, title and headings. It is a map, not
content: no line of what any file *says* appears in it, which is what keeps it affordable and
keeps the bible reached by query. The table of contents is the point — it turns a blind
`search_bible` into an aimed one, because the agent can see that `wiki/history/the-war.md` has a
`Casualties` heading before it queries. The file is budgeted (8000 characters, spent cast-first),
and a section that could not print every row says how many it dropped and which tool answers the
rest. The same act is the desktop's `workspace.reindex`.

`search` and `search_bible` are separate on purpose. `search` scans the authored input files —
a bounded set, so it can afford to be exhaustive and unranked. `search_bible` queries `wiki/`,
which is unbounded, so it is ranked and capped at a character budget; there is no tool that
returns a bible file whole. `list_workspace` reports the bible only as a file count, so the
agent learns one exists without paying for it. See [`story-bible.md`](story-bible.md).

## Skills

Reusable authoring playbooks live under `<dir>/.aiagent/skills/<id>/SKILL.md` (front-matter:
`name`, `description`, `when-to-use`). A pure-prose skill returns its body as guidance; a skill
with a `run.{mjs,js,cjs,sh}` script runs a vetted command — and **each run is permissioned**
(always-confirm), executing in the workspace root with the workspace path as its first argument.
See [`examples/sample/.aiagent/skills/new-character`](../examples/sample/.aiagent/skills/new-character).
