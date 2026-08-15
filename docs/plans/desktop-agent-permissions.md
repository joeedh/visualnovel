# The desktop answers the agent: `ask_user` and always-confirm

## Context

`vnauthor`'s permission gate has three doors (`packages/authoring/src/loop.ts`): `approvePlan`,
`confirmAction`, and `ask`. The REPL implements all three over its one readline channel. The
desktop implements **one**:

```ts
// apps/desktop/src/main/session.ts
private permission(): Permission {
  return {
    approvePlan: (plan) => this.deps.requestPlan(plan),
    // TODO(desktop): route confirmAction / ask through the renderer too once the
    // corresponding UI (skill-run confirm, free-form prompts) is built.
    confirmAction: () => Promise.resolve(true),
    ask: () => Promise.resolve(''),
  };
}
```

Both scaffolds are wrong in a way that shows. `ask` resolves to the empty string immediately, so
the agent's clarifying question is answered by nobody before the author can see it was asked —
which is the author's report that "the tool the agent uses to ask users questions appears to do
nothing." It is worse than silence: the observation fed back to the model is `User answered:`,
so the model is told it got an answer and proceeds on whatever it guessed.

`confirmAction` returning `true` is the same hole pointed the other way. Every always-confirm
tool — `git_revert`, `git_restore`, the first run of a script-bearing skill, and now
`generate_image` and `edit_image`, which spend real money on a real image call — is auto-allowed
in the desktop. The gate exists and the app answers for the user without asking.

Plan approval already works and is the shape to copy, so this is plumbing, not design.

## The shape, which already exists

`requestPlan` (`apps/desktop/src/main/index.ts`) is a request/reply pair over IPC around a
promise main holds open:

- main resolves an id, stores the `resolve` in `pendingPlans`, sends `permission:plan`;
- the renderer's `agent.ts` puts the request in the `Convo` (`proposed`), the convo pane draws a
  card, and the buttons `invoke('plan:decision', {id, decision})`;
- main looks the id up and resolves the promise the agent turn is blocked on.

Two more pairs, built exactly like it.

## Stage 1 — the channels

`apps/desktop/src/shared/ipc.ts`:

- `AskRequest { id: number; question: string }` and `ConfirmRequest { id: number; tool: string;
  detail: string }` beside `PlanRequest`.
- Pushes: `permission:ask` and `permission:confirm`. Replies: `ask:answer`
  `({id, answer: string})` and `confirm:decision` `({id, allowed: boolean})`.

`detail` is a **sentence**, not the raw args: the confirm card has to read as English, and what a
tool's arguments mean is the main process's business, not the card's. It is built where the
`Permission` is, from the tool name and its args.

`SessionDeps` gains `requestAnswer(question): Promise<string>` and
`requestConfirm(tool, detail): Promise<boolean>`; `session.ts`'s `permission()` returns them and
the TODO goes. `index.ts` wires both with the `pendingPlans` idiom (one map each, one seq each).

**Teardown resolves the pending ones.** Main is blocked on a promise the renderer may never
answer — the window can close, or `workspace.open` can tear the session down mid-turn. Every
pending question resolves to `''` and every pending confirmation to `false` (deny) when the
window goes away, so an agent turn ends rather than hanging forever. This is a real hole in the
existing plan path too; fix all three in one place.

## Stage 2 — the conversation

`renderer/pathux/convo.ts` — pure, tested, same as `proposed`/`decided`:

- `Convo` gains `question: AskRequest | null` and `confirm: ConfirmRequest | null`.
- `queried` / `answeredQuestion`, `confirmAsked` / `confirmDecided`.
- Answering pushes the answer into the feed as a `user` item, because it *is* the author's turn —
  a transcript that shows the question and not the answer reads as unanswered.

`renderer/pathux/agent.ts` subscribes to both channels and exposes `answer(text)` /
`allow(boolean)` alongside `decide`.

**One card at a time.** The agent asks one thing per step (`dispatch` awaits each), so the pane
never has to draw two cards, and a card is drawn in the transcript exactly where the plan card
is drawn.

## Stage 3 — the pane

`renderer/pathux/editors/convo.ts`, beside `planCard`:

- **Question card**: the question, a one-line input focused on arrival, Enter (or a Send button)
  answers. An empty answer is still an answer — the model gets `User answered:` — so the button
  stays enabled and the emptiness is the author's choice rather than a hidden default.
- **Confirm card**: the tool, the sentence, `Deny` / `Allow →`. Deny is first and unaccented,
  like `Reject` on the plan card, so the safe click is the one nearest the thumb.

The composer is closed while a turn is in flight (`busy`), which is exactly when these cards
appear — so there is no contest for the Enter key.

## Verification

1. `pnpm check` (both passes), `pnpm test`, `pnpm lint`, `pnpm build`.
2. Unit: the four reducers, including that answering clears the card and pushes the feed item.
3. Live, `--mock`: the mock backend does not ask questions, so drive it from main — a temporary
   `agent.*` invocation is not worth building; instead assert over CDP that
   `art.generate` (a `confirm: true` **command**, a different gate) still behaves, and cover the
   agent gate with a session-level test that stubs `requestAnswer`/`requestConfirm` and asserts
   the agent's observation carries the real answer and that a denied tool is not run.
4. The teardown case: a pending question with the window gone resolves rather than hanging.
