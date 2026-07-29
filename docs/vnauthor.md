# `vnauthor` — the authoring agent

A plan-first, git-backed conversational agent that helps an author write and refine the inputs
the pipeline consumes. It does **not** run the generative pipeline — it stops at well-formed,
validated input files in a clean commit. Design:
[`authoring-agent-report.md`](authoring-agent-report.md); plan:
[`plans/authoring-agent-implementation.md`](plans/authoring-agent-implementation.md).

<!-- toc -->

- [Running it](#running-it)
- [How it works](#how-it-works)
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
  `@import` lines; `AGENTS.md`/`CLAUDE.md` as fallbacks) > inferred defaults. `update_context`
  turns a chat instruction into a durable line in `AICONTEXT.md`.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `applyCharacterEdit` /
  `applyLocationEdit` serializers (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed front-matter
  so untouched prose and branch markers are preserved.

## Skills

Reusable authoring playbooks live under `<dir>/.aiagent/skills/<id>/SKILL.md` (front-matter:
`name`, `description`, `when-to-use`). A pure-prose skill returns its body as guidance; a skill
with a `run.{mjs,js,cjs,sh}` script runs a vetted command — and **each run is permissioned**
(always-confirm), executing in the workspace root with the workspace path as its first argument.
See [`examples/sample/.aiagent/skills/new-character`](../examples/sample/.aiagent/skills/new-character).
