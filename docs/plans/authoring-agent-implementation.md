# Authoring Agent — Implementation Plan

> Implements the design in [`docs/authoring-agent-report.md`](../authoring-agent-report.md).
> Scope: a plan-first, git-backed, format-aware conversational agent that helps a user
> **author and refine the input files** the VN Generator consumes — characters, the
> branching Fountain screenplay, and locations. It operates on the **input/authoring**
> side only and is deliberately separate from the generative image pipeline
> ([`docs/vn-generator-report.md`](../vn-generator-report.md) §9.1): it never runs P1–P7,
> it prepares and maintains the source files those phases read.

---

## 1. Guiding architecture decisions

The generator already separates **deterministic plumbing** (parse, model, validate,
store) from **generative steps** (the pipeline/scheduler). The authoring agent lives
entirely on the deterministic input side and reuses those packages without ever pulling
in `@vn/pipeline` or `@vn/scheduler`. Two decisions up front:

- **Reuse the input-side core; build only the glue.** Discovery, parsing, the project
  model, validation, the input contract, and the LLM seam already exist. The agent adds
  a conversation loop, a tool registry over the existing functions, plan-mode, git, and
  skills — plus a few gap-filling additions to existing packages (round-trip
  serialization). It must not duplicate parsing or validation.
- **Swappable agent backend; structured-output first.** The loop is written against an
  internal `AgentBackend` interface so the tool-call protocol can evolve. The MVP runs a
  structured (ReAct-style) tool loop on the **existing** `ChatBackend` seam — zero
  changes to `@vn/providers`, fully testable offline with `RecordedChatBackend`. Native
  tool-calling is added later behind the same interface.

The agent inherits the workspace's existing toolchain unchanged: pnpm workspaces,
source-only internal packages, `tsgo --noEmit` as the gate, esbuild for the app bundle
and the jest transform, prettier, and the `eslint-plugin-boundaries` layering rule.

---

## 2. What already exists (reuse, do not rebuild)

Confirmed by inspecting the current `packages/*/src`:

| Need | Reuse |
|---|---|
| Discover + load input files | `loadInputs(paths)` → `{ scriptText, characterDocs, locationDocs }` (`@vn/store`) |
| Project paths / layout | `ProjectPaths` (`@vn/store`) |
| Parse Fountain + branch markers + front-matter | `parseFountain`, `parseBranchMarker`, `parseFrontMatter`, `stringifyFrontMatter` (`@vn/parse`) |
| Build + validate model, reachability, mermaid | `buildModel`, `isValid`, `errors`, `successors`, `computeReachable`, `toMermaid`, `slug` (`@vn/model`) |
| Entity ← text (read direction) | `characterFromDoc`, `locationFromDoc`, `splitScenes` (`@vn/model`) |
| Schemas (character/location/scene/project) | zod schemas in `@vn/types` |
| LLM seam (chat, structured output, retry) | `ChatBackend`, `TextLLM`, `ChatTextLLM`, `withStructuredRetry`, `parseStructured`, `createProviders`, `createMockProviders`, `RecordedChatBackend` (`@vn/providers`) |
| Config + key resolution (secret-safe) | `loadConfig`, `resolveKeys` (`@vn/config`) |
| Logger, atomic writes, errors, hashing, pool | `@vn/util` |

## 3. What is new (the gaps)

| Gap | Home |
|---|---|
| Entity → text (write-back / round-trip) | **extend `@vn/model`**: `characterToDoc`, `locationToDoc`, `sceneToFountain`, re-validating `apply*Edit` helpers |
| Git wrapper | **new `@vn/git`** (depends on `@vn/util` only) |
| Workspace index + `AICONTEXT.md` loading (+ nested + `@import`) | **new `@vn/authoring`** |
| Agent loop, tool registry, plan-mode state machine, permission gate | **new `@vn/authoring`** |
| Skills discovery + (permissioned) execution | **new `@vn/authoring`** |
| Interactive REPL binary | **new `apps/authoring`** (`vnauthor`, esbuild-bundled) |

---

## 4. Layering (extends the existing acyclic graph)

```
        types  util
          │ │    │
        config parse
          │   │ │ │
          │  model store ── git (new; util-only)
          │     │   │   │
          │   providers  │
          │     │  │     │
          └──┬──┴──┴─────┘
             ▼
        authoring (new)        ← input-side agent core; NO pipeline/scheduler
             │
      apps/authoring (new)     ← esbuild-bundled REPL: `vnauthor`
```

`@vn/authoring` may depend on `types, util, config, parse, model, store, providers, git`
— and is **forbidden** from importing `@vn/pipeline` / `@vn/scheduler`. A
`eslint-plugin-boundaries` rule asserts this so the separation is enforced, not just
documented.

---

## 5. Package catalog (new + extended)

| Package | Responsibility | Report § | Depends on |
|---|---|---|---|
| `@vn/model` *(extend)* | Add the **inverse** of the existing readers: `characterToDoc`, `locationToDoc`, `sceneToFountain` (built on `stringifyFrontMatter`), and `applyCharacterEdit`/`applyLocationEdit` that re-validate a patched entity through the `@vn/types` schemas before returning. Round-trip property: `fromDoc(toDoc(x)) ≡ x`. | §2 | (unchanged) types, util, parse |
| `@vn/git` *(new)* | Thin promisified wrapper over the `git` CLI: `isRepo`, `isDirty`, `status`, `add`, `commit({message})`, `log`, `show`, `diff`, `revert(ref)`, `restore(path, ref)`, `init`. Returns structured results; spawns via `node:child_process`, never interactive. **No policy** — gating lives in the agent. | §5 | util |
| `@vn/authoring` *(new)* | The agent core (see §6). Workspace index, context loading, tool registry, agent loop, plan-mode + permissions, skills. | §1–§8 | types, util, config, parse, model, store, providers, git |
| `apps/authoring` *(new)* | `vnauthor` interactive REPL: renders plan diffs, prompts for approval, streams turns. Bundled by esbuild like the existing CLI. | §9 | authoring (+ config, store) |

---

## 6. `@vn/authoring` internals

Five modules, each thin glue over reused functions:

1. **`workspace.ts`** — a cheap project index (ids of characters/locations/scenes, no
   full bodies) assembled from `loadInputs` + `buildModel`; refreshes after edits. Knows
   what exists without reading everything.
2. **`context.ts`** — assembles agent context with precedence **built-in system prompt
   (the input contract) > `AICONTEXT.md` (+ nested per-dir files + `@import`) > inferred
   defaults**. `updateContext(rule)` turns a chat instruction into a durable line in
   `AICONTEXT.md`. Honors `AGENTS.md`/`CLAUDE.md` as fallbacks.
3. **`tools.ts`** — the tool registry (report §7). Each tool = `{ name, argsSchema (zod),
   mutating: boolean, run }`. Mapping to reuse:
   - file/content: `read_file`, `list_workspace` (workspace index), `search`,
     `edit_file` (model serializers, mutating)
   - domain: `validate_inputs` (= `buildModel` + `errors`), `parse_fountain`,
     `story_graph` (= `toMermaid` + `computeReachable`), `extract_entities`
   - git: `git_status/commit/log/show/diff/revert/restore/init` (over `@vn/git`)
   - context/skills: `load_context`, `update_context`, `discover_skills`, `run_skill`
   - control: `enter/exit_plan_mode`, `ask_user`
4. **`loop.ts`** — the conversation loop over `AgentBackend`, the plan-mode state machine
   (§7), and the permission gate. Validates each model action against the tool registry's
   arg schemas via `withStructuredRetry`.
5. **`skills.ts`** — scan `.aiagent/skills/` (project) + a global dir; parse front-matter
   (`name`, `description`, `when-to-use`); invoke explicitly (`/skill`) or by description
   match. First run of a script-bearing skill is permissioned.

### Agent backend & tool protocol (key decision)

The current `ChatBackend.message(req) → string` is text-in/text-out with structured
output enforced by JSON parsing + retry; it has **no native tool-calling**. The loop
targets an internal `AgentBackend` interface so we can swap protocols:

- **Path A (MVP, default):** structured ReAct on the existing seam — the model emits a
  zod-validated `{ tool, args }` action, we execute and feed back an observation. No
  `@vn/providers` change; testable today with `RecordedChatBackend`.
- **Path B (enhancement):** add `chatWithTools(req, tools) → { text?, toolCalls[] }` to
  `ChatBackend` and implement native function-calling in the Gemini/Claude backends.

Decision: **ship A, then add B behind the same `AgentBackend` interface.**

---

## 7. Plan mode & permission model

A two-state machine in `loop.ts`:

- **plan (read-only):** only `mutating: false` tools dispatch; the gate rejects mutating
  tools. Output is a structured `Plan` — ordered steps, files touched, a unified-diff
  preview built from the round-trip serializers, and flagged risks.
- **execute (read-write):** entered only on explicit approval. Applies edits → runs
  `validate_inputs` → **blocks commit on error-severity diagnostics**, warns
  (non-blocking) on soft/style issues → `git_commit` (one commit per approved plan).

Always-confirm (regardless of mode): `git_revert`/`restore` (must name the target ref),
file deletion, first run of a script-bearing skill. **Secret hygiene** is inherited —
keys resolve via `resolveKeys`, are never read into context or logged; `keys/` and
`.vngen/` stay gitignored. If the tree is dirty with non-agent changes, surface them
before committing rather than sweeping them in. If not a git repo, offer `git init`,
don't require it.

---

## 8. Milestones

Each keeps `pnpm check`, `pnpm test`, and `pnpm lint` green.

1. **M1 — round-trip + git.** `@vn/model` serializers (+ `fromDoc(toDoc(x)) ≡ x`
   round-trip tests) and `@vn/git` (+ temp-repo tests via `mkdtemp`). Pure; no agent.
2. **M2 — `@vn/authoring` foundations.** workspace index, context loader (`AICONTEXT.md`
   + nested + `@import`), tool registry over reused funcs, `validate_inputs` /
   `story_graph` / `extract_entities`. Unit-tested without an LLM.
3. **M3 — agent loop (Path A).** `AgentBackend` interface, ReAct tool loop, plan-mode
   machine + permission gate. End-to-end tested with `RecordedChatBackend` (scripted tool
   sequences); no network.
4. **M4 — `apps/authoring` REPL.** Interactive binary, diff preview, approval UX, esbuild
   bundle, boundaries lint rule forbidding pipeline/scheduler imports.
5. **M5 — skills + native tool-calling (Path B).** Skill discovery/run with
   permissioning; `chatWithTools` in the backends behind the same interface.
6. **M6 — docs + sample.** Extend `CLAUDE.md`; add a sample `AICONTEXT.md` and an example
   skill under `examples/sample`.

---

## 9. Open decisions (report §11)

| Decision | Recommendation |
|---|---|
| Tool protocol | Ship Path A → add Path B behind `AgentBackend`. |
| Binary surface | Separate `vnauthor` app (interactive vs. batch are different shapes) over a `vngen author` subcommand. |
| Serialization home | Round-trip in `@vn/model` (it owns entity↔doc) over a new `@vn/serialize`. |
| Auto-commit granularity | One commit per approved plan (legible history). |
| Validation strictness | Block commit on hard errors; warn (don't block) on soft/style. |
| Context precedence | built-in > `AICONTEXT.md` > inferred; `AGENTS.md`/`CLAUDE.md` as fallback. |

---

## 10. Risks

- **No native tool-calling in the current seam.** Mitigated by Path A (structured ReAct)
  with a swap path to Path B; the `AgentBackend` interface isolates the choice.
- **Round-trip fidelity.** Editing must preserve untouched prose/markers. Mitigated by
  property tests and by only rewriting front-matter that actually changed.
- **Layering leakage.** The agent must never reach into the generative pipeline.
  Enforced by an `eslint-plugin-boundaries` rule, not just convention.
- **Windows fs/process specifics.** `@vn/git` spawns the `git` CLI and writes via the
  existing atomic-write helpers; tests run against temp repos to catch path/quoting
  issues early.
