# The Authoring Agent — Design Report

<!-- toc -->

- [1. What the agent is for](#1-what-the-agent-is-for)
- [2. Domain awareness (what the agent must "know")](#2-domain-awareness-what-the-agent-must-know)
- [3. Context loading: `AICONTEXT.md` and friends](#3-context-loading-aicontextmd-and-friends)
- [4. Plan mode](#4-plan-mode)
- [5. Git integration](#5-git-integration)
- [6. User-authored skills (extensibility)](#6-user-authored-skills-extensibility)
- [7. Tools the agent needs](#7-tools-the-agent-needs)
    - [File & content](#file--content)
    - [Domain / validation](#domain--validation)
    - [Git](#git)
    - [Context & skills](#context--skills)
    - [Interaction control](#interaction-control)
- [8. Permissions & safety model](#8-permissions--safety-model)
- [9. A typical session](#9-a-typical-session)
- [10. Architecture at a glance](#10-architecture-at-a-glance)
- [11. Open questions / decisions to make](#11-open-questions--decisions-to-make)
- [12. Summary](#12-summary)

<!-- tocstop -->

Scope: the agent converses with a user to author and refine the input files for the visual
novel generator — character descriptions, the branching screenplay (Fountain + branch
markers), and location descriptions. It chats about the story, makes edits on the user's
behalf, plans before acting, integrates with git, knows the required input formats, loads
project context from an `AICONTEXT.md` file, and is extensible with user-authored skills.
This agent operates on the input/authoring side (see vn-generator-report.md §9.1). It does
not run the generative image pipeline; it prepares and maintains the source files that
pipeline consumes. The two are separate concerns connected by the input directory
contract.

---

## 1. What the agent is for

The input files are the single source of truth for the whole generator. They are also the
part a human most wants to iterate on, by tweaking a character's backstory, rewriting a
branch, or splitting a location. The authoring agent makes that iteration conversational
while keeping the files valid, consistent, and version-controlled.

Core responsibilities:

1.  1. **Discuss the story** — answers questions, summarizes, finds inconsistencies, and
       suggests options ("what if Aiko's arc diverged earlier?").
2.  2. **Edit input files** — create or modify characters, locations, and screenplay
       scenes, always producing output that conforms to the required formats.
3.  **Plan before acting** — propose a change set, get approval, then execute (plan mode).
4.  4. **Track history** — auto-commits edits to git, shows history, and reverts on
       request (with explicit confirmation).
5.  5. **Know the conventions** — read `AICONTEXT.md` for the required files, the required
       formats, and the project's own conventions.
6.  **Be extensible** — let users drop in their own skills.

---

## 2. Domain awareness (what the agent must "know")

The agent has a built-in understanding of the input contract, so it never produces
malformed files:

- **Project layout**: the `input/` side of the generator report holds `project.yaml`,
  `characters/<id>/character.md` (plus an optional `refs/`), `locations/<id>.md`, and
  `screenplay/*.fountain`. As shipped, each scene is authored in its own `scenes/<id>.md`
  file and `start:` names the entry scene, and `screenplay/` is not read at all; the agent
  tells the author to run `vngen import` rather than editing a Fountain file. See
  [`../reference/fountain.md`](../reference/fountain.md#where-the-fountain-lives-project-specific).
- **Character file schema** — a character file holds YAML front-matter (`id`, `name`,
  `status`, `default_outfit`, `palette`, …), a canonical prose description, and a wardrobe
  section. As shipped, `reference_images` is retired: it stored data nothing read, and a
  file that still sets it gets a diagnostic. A reference image now attaches to a prompt
  clause (`prompt.addRef`), not to a character.
- **Location file schema** — description, mood/lighting, time-of-day/weather variants,
  camera notes.
- **Fountain + branch markers** — the agent knows Fountain syntax (see fountain.md) and
  the project's branching convention (scene graph, `goto`/`choices`).
- **Cross-file invariants** — every character referenced in the screenplay exists; every
  branch target resolves; outfit ids referenced in scenes exist; location ids are
  consistent (alias detection).

This domain knowledge ships as a system prompt plus a bundled reference skill (for
example, a built-in `validate-inputs` capability), so it is always available and
consistent. The two existing docs (fountain.md, vn-generator-report.md) are the
authoritative spec the agent is built against.

---

## 3. Context loading: `AICONTEXT.md` and friends

On startup (and when the workspace changes) the agent assembles its context from:

1.  1. **Built-in system prompt** — covers the role, the input contract, and the safety
       rules.
2.  2. **`AICONTEXT.md`** in the workspace root holds the user's project-specific guidance
       and is loaded into context the same way Claude Code uses `CLAUDE.md` / `AGENTS.md`.
       This file is where the author records tone, canon, style rules, naming conventions,
       "things you always get wrong about my world," etc.
3.  **Nested / discovered context** (optional, recommended): support `AICONTEXT.md` files
    in subdirectories (e.g. a per-character note) that are pulled in when the agent works
    in that area, plus an `@import` / `@path` mechanism so a context file can reference
    others. Honor `AGENTS.md`/`CLAUDE.md` as fallbacks if present, for familiarity.
4.  4. **Live project snapshot** — Holds a cheap index of which characters, locations and
       scenes exist, without their full bodies, so the agent knows what is there without
       reading everything.

Built-in rules take precedence over the user's `AICONTEXT.md`, which in turn takes
precedence over inferred defaults. The agent should be able to update `AICONTEXT.md` when
the user says "always remember X about the story", which turns a chat instruction into
durable project context.

---

## 4. Plan mode

The interaction model has two states, mirroring Claude Code's plan mode:

- **Chat / plan mode (read-only):** the agent can read files, search, inspect git history,
  and propose a plan, but makes no edits. Used for discussion, exploration, and designing
  a change.
- **Execute mode (read-write):** the agent applies the edits, runs validation, and commits
  once the user approves a plan.

Flow:

```
user: "Make Ren more guarded early on, then warming after the rooftop scene."
   │
   ▼  (plan mode)
agent proposes a PLAN:
   1. Edit characters/ren/character.md — adjust temperament in description
   2. Edit screenplay scene s05, s07 dialogue — terser, defensive
   3. Add note to AICONTEXT.md: "Ren's warmth is earned, not default"
   → shows a diff preview, lists files touched, flags risks
   │
   ▼  user approves  (→ execute mode)
agent applies edits → runs validate-inputs → git commit → reports result
```

Plan mode guards an agent that edits creative source files: the user sees what will change
before anything is written, and every change lands as a reviewable commit.

---

## 5. Git integration

If the workspace is a git repository, the agent undoes changes and reads history through
git.

- **Auto-commit on change.** After each approved edit set, the agent stages and commits
  with a descriptive message ("Soften Ren's early dialogue; update temperament"). Each
  logical change becomes one commit, so the history stays readable and any single change
  can be reverted on its own.
- **View history.** The agent can show the log, diff any commit, and summarize "what
  changed and why" in plain language. This helps an author returning after time away.
- **Revert with permission.** The agent can revert a commit or restore a file to an
  earlier state, but only after explicit user confirmation naming the target commit.
  Prefer `git revert` (a new commit undoing the changes) over destructive `reset --hard`
  to keep history intact; offer `reset` only when the user explicitly asks and understands
  the consequence.
- **Safety rails:**
    - Never commit secrets (the user's Gemini/API keys live outside the repo or in
      `.gitignore`d config).
    - If the working tree is dirty with changes the agent did not make, report them before
      committing rather than sweeping them in.
    - Work on the current branch by default; offer to branch for large or experimental
      rewrites.
    - If the workspace is not a git repo, offer to run `git init` so that history and undo
      are available, but do not require it.

---

## 6. User-authored skills (extensibility)

Users can teach the agent new capabilities by dropping **skills** into the workspace.

- **Skill structure.** A skill is a self-contained folder holding a definition file
  (`skill.md`/`SKILL.md` with front-matter: `name`, `description`, `when-to-use`) plus
  optional supporting files and scripts. The agent decides whether a skill is relevant
  from its `description` and `when-to-use`, the same model Claude Code skills use.
- **Discovery:** the agent scans a conventional location (for example `.aiagent/skills/`
  in the project and a user-global directory) and lists the discovered skills in its
  context. The user invokes one explicitly (`/my-skill`), or the agent triggers it when
  the description matches the task.
- **Examples a user might write:**
    - `name-checker` — verifies character names against a canon glossary.
    - `dialogue-pass` — rewrite a scene's dialogue in a defined voice.
    - `branch-linter` — enforces project-specific rules for valid choice structures.
    - `- `import-from-outline` — turn the user's outline format into scaffolded scene files.`
- **Trust model:** A skill may include scripts, and running those is a permissioned action
  (see §8). The agent describes what a skill will do before the first run.

This keeps the core agent small while letting each author encode their own workflow.

---

## 7. Tools the agent needs

The tools are grouped by concern. The names are illustrative. The shipped registry is
`packages/authoring/src/tools.ts`, and its 23 tools are enumerated in
[`../reference/vnauthor.md`](../reference/vnauthor.md). That registry follows this
grouping with four differences. Editing is typed per entity — `create_character`,
`create_location`, `edit_character`, `edit_location` — rather than a generic `edit_file`,
so every write goes through `@vn/model`'s round-trip-safe serializers. `load_context` is
not a tool, because context is loaded before the loop starts rather than requested by the
model. The interaction-control group has no tools at all: the REPL and the permission gate
control mode, not anything the model can call, so plan mode is enforced rather than
requested.

### File & content

| Tool                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `read_file`                | Read a file (or page range).                                             |
| `list_workspace`           | Cheap structural index of characters/locations/scenes.                   |
| `search`                   | Content/regex search across input files (find a name, a location alias). |
| `write_file` / `edit_file` | Create or modify input files (execute mode only).                        |

### Domain / validation

| Tool               | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `validate_inputs`  | Check schema conformance + cross-file invariants; report errors with file:line. |
| `parse_fountain`   | Parse the screenplay; expose scenes, cues, headings, branch markers.            |
| `story_graph`      | Build/inspect the branching scene graph; find unreachable/dangling scenes.      |
| `extract_entities` | List characters/locations referenced vs. defined (drift detection).             |

### Git

| Tool                                | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `git_status`                        | Working-tree state before/after edits.                    |
| `git_commit`                        | Stage + commit an approved change set with a message.     |
| `git_log` / `git_show` / `git_diff` | View history and inspect changes.                         |
| `git_revert` / `git_restore`        | Undo a commit/file — **gated on explicit confirmation**.  |
| `git_init`                          | Initialize a repo when none exists (offered, not forced). |

### Context & skills

| Tool              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `load_context`    | Read `AICONTEXT.md` (+ nested/imports) into context.     |
| `update_context`  | Persist a durable instruction into `AICONTEXT.md`.       |
| `discover_skills` | Find user/project skills and surface their descriptions. |
| `run_skill`       | Execute a skill (permissioned if it runs scripts).       |

### Interaction control

| Tool                                 | Purpose                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `enter_plan_mode` / `exit_plan_mode` | Toggle read-only planning vs. execution; `exit` presents the plan for approval. |
| `ask_user`                           | Ask a focused clarifying/decision question when blocked.                        |

---

## 8. Permissions & safety model

- **Mode-gated writes.** The agent does not write files or commit in plan mode or chat
  mode. It writes and commits only after a plan is approved.
- **Confirmation for irreversible/outward actions.** Reverts, hard resets, file deletions,
  and the first run of a script-bearing skill require explicit user approval.
- **Diff-first.** Every edit can be previewed as a diff before it is written, and every
  change becomes a commit, so a git workspace can recover any change.
- **Secret hygiene.** API keys are never read into context, committed, or logged.
- **Scoped to the workspace.** The agent operates within the project directory and does
  not reach outside it.
- **Honest reporting.** If validation fails or a commit is skipped, the agent reports that
  with the actual output rather than claiming success.

---

## 9. A typical session

```
1. Open workspace → agent loads system prompt + AICONTEXT.md + project index.
2. User: "Is the rooftop branch reachable from both endings?"
   → agent (plan/read-only): runs story_graph, answers, shows the subgraph.
3. User: "Add a new optional scene where Ren apologizes; branch from s12."
   → agent proposes a PLAN (new scene file, edit s12 choices, validate).
4. User approves → agent (execute): writes files, runs validate_inputs (passes),
   git_commit "Add optional apology scene branching from s12".
5. User: "Actually, revert that."
   → agent confirms the target commit, then git_revert; reports new HEAD.
6. User: "From now on, Ren never apologizes directly."
   → agent update_context: appends the rule to AICONTEXT.md, commits it.
```

---

## 10. Architecture at a glance

```
            ┌──────────────────────────────────────────────┐
            │              Authoring Agent                  │
            │  system prompt (input contract + safety)      │
            │  + AICONTEXT.md (+ nested/imports)            │
            │  + discovered skills (project/global)         │
            └───────────────┬──────────────────────────────┘
                            │  plan mode  ⇄  execute mode
        ┌───────────────────┼───────────────────────────────┐
        ▼                   ▼                   ▼             ▼
   File/Content        Domain/Validate        Git        Context/Skills
   read/search/edit    fountain/graph/        log/commit/ load/update/
                       validate/entities      revert(gated) discover/run
        │                   │                   │             │
        └───────────────────┴─────────┬─────────┴─────────────┘
                                       ▼
                          input/ workspace (the source of truth)
                          characters/  locations/  screenplay/  project.yaml
                          AICONTEXT.md   .aiagent/skills/   .git/
```

---

## 11. Open questions / decisions to make

| Question                      | Note / recommendation                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Auto-commit granularity       | One commit per approved plan (recommended) vs. per file. Per-plan keeps history legible.                 |
| Branch markers in Fountain    | Finalize the exact marker syntax (report §6) so `parse_fountain`/`story_graph` agree with the generator. |
| Skill format                  | Reuse the Claude Code skill shape (front-matter + `when-to-use`) for familiarity.                        |
| Context precedence            | Confirm `AICONTEXT.md` > `AGENTS.md`/`CLAUDE.md` fallback ordering.                                      |
| Multi-user / concurrent edits | Out of scope initially; git is the merge mechanism if needed.                                            |
| Validation strictness         | Block commit on hard errors; warn (don't block) on soft/style issues.                                    |

---

## 12. Summary

The authoring agent is a plan-first, git-backed, format-aware conversational editor for
the visual novel's input files. It knows the required file schemas and Fountain, so it
does not write malformed input. It plans changes before making them, commits every
approved edit to git, reverts with permission, reads a workspace `AICONTEXT.md` for
grounding, and is extended by user-authored skills. It is separate from the
image-generation pipeline by design. Its work is limited to keeping the source-of-truth
input files coherent, valid, and easy to evolve.
