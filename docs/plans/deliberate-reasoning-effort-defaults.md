# Deliberate reasoning-effort defaults

Status: **shipped**

The effort menu offered `default` — the knob left off — and that is what every surface started
at. On the models this project actually uses, "the knob left off" is not a neutral setting: on
Opus 4.7/4.8 and Sonnet 4.6 a request with no `thinking` field runs **without thinking at all**,
and the backend paired that branch with `max_tokens: 2048`. So the shipped default was the least
capable configuration available, chosen by omission rather than by anyone.

This plan replaces the absent default with a stated one, and makes the menu say what each model
can actually do.

## What changes

1. **`default` stops being an item.** The effort menu offers what the model supports — the levels
   it accepts, plus **`no thinking`** where thinking can be switched off. A model with no knob at
   all still greys the menu and says why.
2. **The default is `low`.** Every surface starts there: the desktop session, the shell state the
   bar draws from, the `vnauthor` REPL, and any `createAnthropicChat` call that passes no effort
   (which is every pipeline call — P1, P5, shot decomposition, and the vision reviewers).
3. **`max_tokens` goes from 2048 to 10000** on the no-thinking path. The thinking path keeps
   16000, because `max_tokens` caps thinking *plus* response text together and thinking needs the
   room.

## Why `no thinking` is a per-model capability

`thinking: {type: "disabled"}` is not universally accepted:

| Model | Effort ladder | `no thinking` |
| --- | --- | --- |
| Opus 4.7 / 4.8 | `low`…`max` | yes — and omitting `thinking` does the same thing |
| Opus 5 / Sonnet 5 | `low`…`max` | yes at effort ≤ `high`; **400 at `xhigh`/`max`** |
| Opus 4.5 / 4.6, Sonnet 4.6 | `low`…`high`, `max` (no `xhigh`) | yes |
| Fable 5 / Mythos 5 | `low`…`max` | **no** — an explicit `disabled` 400s at any effort |
| Haiku 4.5, Sonnet 4.5 and older, Gemini | — | — (`output_config.effort` 400s; the Gemini backend passes none) |

`xhigh` arrived on Opus 4.7, so the models before it stop at `high` and jump to `max`.

Two consequences the code has to honour:

- The **`no thinking` request sends no `output_config` at all**, only `thinking:
  {type: "disabled"}`. That keeps it inside the Opus 5 rule (the API's own effort default is
  `high`, which is accepted) without the caller having to reason about the interaction.
- **A stored choice can outlive the model that offered it.** Picking `xhigh` on Opus 4.8 and then
  switching to Sonnet 4.6 leaves a level the new model will not take. `resolveEffort` clamps to
  the nearest thing the model does offer, and both the backend (at request-build time) and the
  two model menus (at switch time) call it, so the bar never shows a level the wire will not
  carry.

## The shape

Everything model-specific lives in `@vn/types`'s `textmodels.ts`, beside `TEXT_MODELS` — the one
module both `vnauthor` and the renderer can import without pulling in a vendor SDK.

```ts
EFFORT_LEVELS   // 'low' | 'medium' | 'high' | 'xhigh' | 'max' — the API's own values
EFFORT_CHOICES  // 'none' + the levels — what a surface may bind
DEFAULT_EFFORT  // 'low'
effortChoicesFor(modelId)      // what this model's menu offers, in order; empty = no knob
resolveEffort(modelId, choice) // that choice, or the nearest offered one; undefined = no knob
effortLabel(choice)            // 'none' reads as 'no thinking'
supportsEffort(modelId)        // effortChoicesFor(modelId).length > 0
```

`supportsEffort` survives as the predicate the surfaces grey out on; it is now derived from the
table rather than being a second, independently-drifting regex.

## Files

| File | Change |
| --- | --- |
| `packages/types/src/textmodels.ts` | the table above, and `supportsEffort` rewritten over it |
| `packages/types/src/tests/textmodels.test.ts` | new — the per-model ladder, the clamp, the labels |
| `packages/providers/src/backends/anthropic.ts` | `tuning()` over `resolveEffort`; the two `max_tokens` constants |
| `packages/providers/src/index.ts` | re-export the new names |
| `packages/providers/src/tests/providers.test.ts` | `supportsEffort` cases for the models the table now distinguishes |
| `apps/desktop/src/main/session.ts` | `effort: EffortChoice = DEFAULT_EFFORT`; `setModel` clamps |
| `apps/desktop/src/main/commands/agent.ts` | `agent.setEffort` prop is `EFFORT_CHOICES`, no `default` |
| `apps/desktop/renderer/pathux/state.ts` | `effort = DEFAULT_EFFORT` |
| `apps/desktop/renderer/pathux/bridge.ts` | `setModel` clamps the mirrored value the same way |
| `apps/desktop/renderer/pathux/editors/convo.ts` | the menu is `effortChoicesFor(ui.model)`, labelled, and carries a tooltip when enabled |
| `apps/authoring/src/agent.ts` | re-export; `buildAgentBackend` takes an `EffortChoice` |
| `apps/authoring/src/repl.ts` | `/effort` offers the model's own choices and starts at `low` |

## Cost note

Point 2 is a real change to what the pipeline spends. Before this, every non-agent Claude call —
P1 beat extraction, P5 shot decomposition, the vision reviewers — ran with no thinking and a
2048-token ceiling. They now run adaptive thinking at `low` effort with a 16000-token ceiling.
That is the deliberate default, not an accident of omission, but it does cost more per call. The
lever is `resolveEffort`'s input: a caller that wants the old behaviour passes `'none'`.

## As shipped

Built as described. Two details worth recording:

- **The clamp is computed twice, not sent.** `resolveEffort` is pure and lives in a package both
  main and the renderer import, so `bridge.setModel` and `session.setModel` reach the same answer
  without an IPC round trip. No new channel, no correction push.
- **`agent.setEffort` still accepts every choice**, including one the current model does not
  offer. The menu is what filters; the command is what validates the vocabulary. A choice the
  model will not take is clamped at the wire rather than refused, because the setting is
  deliberately kept across a model switch.
