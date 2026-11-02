# A fast helper for learning the desktop app

How to build a helper that answers "how do I…" questions about the desktop app quickly,
and whether a small distilled or fine-tuned model is the right tool for it. Written
2026-11-02. Nothing here is decided.

<!-- toc -->

- [Summary](#summary)
- [What exists today](#what-exists-today)
- [What the helper has to produce](#what-the-helper-has-to-produce)
- [Measurements](#measurements)
- [Option A: retrieval with no language model](#option-a-retrieval-with-no-language-model)
- [Option B: one call to a fast hosted model](#option-b-one-call-to-a-fast-hosted-model)
- [Option C: a small local model, fine-tuned](#option-c-a-small-local-model-fine-tuned)
- [Distillation and RL on small models](#distillation-and-rl-on-small-models)
- [Training data and the reward](#training-data-and-the-reward)
- [Keeping up with UI changes](#keeping-up-with-ui-changes)
- [Recommendation](#recommendation)
- [Open questions](#open-questions)
- [Sources](#sources)

<!-- tocstop -->

## Summary

- The app already has a working helper: the desktop agent's `show_me` tool, backed by the
  `ux_*` reader tools. It is slow because it runs on the project's main chat model and
  takes several tool round trips per question.
- The helper's real job is small. The tour runtime already handles opening panes,
  selecting the right row, scrolling, refusals and the palette fallback. The model only
  has to name the target command, its known props, and any subject to select first.
- That reduces the problem to choosing one of about 230 commands, plus pulling entity
  names out of the question. Embedding search handles most of it without any language
  model. A fast hosted model handles the rest in one call. A fine-tuned local model is
  possible and well supported by current tooling, but it is the last step, not the first.
- If a small model is trained, the UX model is an unusually good source of training data.
  Labels come from `ux-model.json` itself rather than from a teacher model, and a tour can
  be scored automatically with `checkTour` and the anchor resolver. That makes RL with a
  verifiable reward practical.
- The main risk for any trained model is staleness, because the UI changes often. Pass the
  current command list to the model at inference time, constrain its output to valid ids,
  and train it to read that list rather than memorise it.

## What exists today

Details are in
[`../reference/guided-tours.md`](../reference/guided-tours.md#sources-of-tours).

- **Curated tours.** Three are hard-coded in `apps/desktop/src/shared/tours.ts`.
- **`show_me`** (`apps/desktop/src/main/agent/showme.ts`). The desktop agent writes a
  `Tour` and the app plays it. `checkTour` rejects unknown command ids, undeclared props
  and unknown interaction ids before the author sees anything.
- **`ux_list`, `ux_read`, `ux_search`, `ux_check`** (`src/main/agent/uxdocs.ts`). These
  read the generated UX docs tree under `apps/desktop/dist/ux/`, which is folded from
  `ux-model.json`, `anchors.json` and the command registry. `show_me`'s description tells
  the model to `ux_read` a command's page before writing a step.
- **The tour runtime.** `guide()` in `renderer/rules/tour.ts` turns each step into a ring,
  a pick, an "open this pane", a palette route or a blocked step with the command's own
  refusal sentence. Steps advance on `onExec`, whichever control ran the command.

Why the current path is slow:

- It runs on whatever text model the project uses, which is usually a large model.
- The `ux_*` tools are deferred, so a typical answer is a tool search, a `ux_search`, a
  `ux_read`, then `show_me`. That is about four model turns, each with the full agent
  context.
- It shares a conversation with the authoring agent, so it carries that agent's whole
  system prompt and history.

## What the helper has to produce

A `Tour` step is one of four kinds: `command`, `input`, `select` and `gesture`. Because
the runtime resolves navigation itself, a helper usually needs very little:

- **One command step** for most questions. "How do I condense this prompt?" becomes
  `{ kind: 'command', id: 'prompt.condense' }`. If no pane is open that draws the control,
  the runtime says which pane to open. If the control is on a different row, it rings the
  row to click first. If no control exists, it opens the palette on the command.
- **A select step first** when the question names a subject: "how do I give Aiko an art
  note" adds `{ kind: 'select', itemKind: 'character', key: 'aiko' }`. Subject keys come
  from the workspace index, so this is string matching against known names, not
  generation.
- **Several command steps** only for genuine sequences, such as approving a portrait
  before running. These are the minority, and the curated tours already cover the common
  ones.

So the model's output is a short list drawn from a closed vocabulary. That matters for
every option below: it allows grammar-constrained decoding, and it makes every answer
checkable.

## Measurements

Taken from the committed files on 2026-11-02.

| What                                              | Count              |
| ------------------------------------------------- | ------------------ |
| Registry commands (`anchors.json` `commands`)     | 232                |
| Commands with a swept control (`anchored`)        | 106                |
| `paletteOnly` entries in `ux-model.json`          | 77                 |
| Effects                                           | 12 (10 drawn)      |
| Situations in `ux-model.json`                     | 195                |
| Records in `ux-model.json`                        | 2160               |
| … of which control records / menu records         | 1691 / 469         |
| Editors named in records                          | 23                 |
| Shortcuts                                         | 44                 |
| `ux-model.json` size                              | 1.5 MB             |
| UX docs tree (`dist/ux/`)                         | 310 pages, 739 KB  |
| Distinct `id \| editor \| label \| tooltip` lines | 628                |
| Size of those lines                               | 72 KB, ~19K tokens |

The last two rows estimate a compact catalog a model could read in one prompt. The token
figure uses roughly 3.8 characters per token and was not counted with a tokenizer.

## Option A: retrieval with no language model

Embed a short text for each command and search it with the author's question.

- **What to index.** For each command: its registry title and description, the label and
  tooltip of every control and menu entry that runs it (from `ux-model.json`), its refusal
  sentences, and the `paletteOnly` reason where there is one. Refusal sentences are worth
  including because authors often ask about a greyed control by quoting it.
- **Encoder.** A small ONNX sentence encoder through transformers.js runs in Electron with
  no GPU. [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md) already surveys this for
  the story bible (`all-MiniLM-L6-v2` is about 23 MB quantised), so one encoder could
  serve both.
- **Output.** Show the top three candidates as a short list, each with its title and where
  its control lives, and start a one-step tour on the one the author picks. Add a select
  step when a name in the question matches an entity in the workspace index.
- **Speed.** About 230 vectors, so search time is negligible. The cost is encoding the
  question, which takes milliseconds on a laptop CPU for an encoder this size. Not
  measured here.
- **Strengths.** It works offline, costs nothing per question, cannot name a command that
  does not exist, and regenerates its index from the same files `pnpm gen:uxmodel` writes.
- **Weaknesses.** It handles neither multi-step sequences nor "why is this greyed out"
  without extra rules. Its quality depends on the tooltips, so a vague tooltip gives a
  vague match. That is also a reason to fix the tooltip, which the repo's tooltip rule
  already asks for.

## Option B: one call to a fast hosted model

Give a fast model everything it needs in one prompt and force a single `show_me` call,
with no reader tools and no agent conversation.

- **Prompt.** Either the whole compact catalog (~19K tokens, cached) or only the top 20 or
  so candidates from option A (a few hundred tokens). The second is faster and cheaper,
  and the model then only has to choose and sequence.
- **Model.** `claude-haiku-4-5` is already in the curated list in `@vn/types`. Its minimum
  cacheable prefix is 4096 tokens
  ([`prompt-cache-tests-against-live-models.md`](prompt-cache-tests-against-live-models.md)),
  so the full catalog caches and the retrieved shortlist does not need to.
- **Validation.** `checkTour` already runs on every `show_me` tour. On failure, either
  retry once with the error, or fall back to option A's shortlist.
- **Strengths.** It handles paraphrase, multi-step questions and "why can't I" (with
  `ux_check` results included in the prompt) far better than option A. It needs no
  training.
- **Weaknesses.** It needs a key and a network connection, costs money per question, and
  latency is a network round trip plus time to first token.

## Option C: a small local model, fine-tuned

Run a model of a few hundred million to a few billion parameters inside the app.

- **Candidates.** Qwen3 0.6B–4B, Gemma 3 270M–4B, Llama 3.2 1B/3B, Phi-4-mini, SmolLM. The
  closest existing example is Google's FunctionGemma: a 270M Gemma 3 variant built to be
  fine-tuned for function calling on device. Google reports 58% on its Mobile Actions task
  for the base model and 85% after fine-tuning. That task is close in shape to this one,
  mapping a request to a call from a fixed set.
- **Runtime.** `node-llama-cpp` (GGUF) or ONNX Runtime through transformers.js. An ONNX
  build of FunctionGemma is already published. See
  [`local-and-self-hosted-models.md`](local-and-self-hosted-models.md) for the wider
  runtime survey.
- **Constrained decoding.** Generate the tour under a JSON grammar whose `id` field only
  accepts current command ids. llama.cpp supports GBNF grammars directly. The model can
  then pick the wrong command but cannot invent one, and output is a few dozen tokens.
- **Speed.** For a 1B model, prompt processing of a 1–2K-token context will likely cost
  more than generating the answer. This is unmeasured here. Measure it on a mid-range
  laptop CPU before choosing a model size.
- **Costs.** A model file of 150 MB to 2 GB in the installer or downloaded on first use, a
  training pipeline to maintain, and an evaluation set to keep current.

## Distillation and RL on small models

This is common practice. The relevant variants:

- **Teacher-written data, then supervised fine-tuning.** A large model writes examples and
  the small model is fine-tuned on them. This is how the DeepSeek-R1 distilled Qwen and
  Llama models were made, and how the Phi series was trained. LoRA fine-tuning of a 1–3B
  model fits on one consumer GPU with Unsloth, TRL or Axolotl.
- **Matching the teacher's token probabilities.** This needs the teacher's weights or full
  log-probabilities, so it is only possible with an open-weights teacher. With a hosted
  model you only get text.
- **RL with a verifiable reward.** GRPO on small models for tool calling has published
  results: the arXiv paper 2509.04518 rewards valid JSON, correct tool choice and correct
  arguments, and reports large accuracy gains. Unsloth and TRL both support GRPO. One
  practitioner report found little gain over an already strong 8B base model, so start RL
  only after SFT and only if SFT plateaus.
- **Terms.** Anthropic's Commercial Terms (section D.4) forbid using the services to train
  competing AI models without approval. A narrow in-app helper that picks command ids is
  unlikely to be a competing model, but that is a reading, not a ruling. Using an
  open-weights teacher avoids the question.

## Training data and the reward

The UX model makes data and evaluation unusually cheap.

- **Labels come from the model file.** Every control record has a command id, a label, a
  tooltip, an editor and a situation with a `why` sentence. A teacher model only has to
  write questions an author might ask about that record. The answer is the record's id, so
  the label is correct by construction. Refusal records give "why can't I" questions with
  known answers.
- **Subject steps.** Generate questions that name fixture entities and label them with the
  matching `select` step.
- **Multi-step examples.** Use the three curated tours, plus sequences where one command's
  refusal names another (approve before run). There are few of these, so expect to write
  some by hand.
- **Reward for RL**, all computed without a person:
    - `checkTour` passes (0 or 1).
    - The final command step names the labelled command.
    - Each step resolves under `resolveAnchor` against `anchors.json`, or falls back to
      the palette for a `paletteOnly` command.
    - Fewer steps is better, given the first three hold.
- **Evaluation set.** Real author questions are better than generated ones. Saved threads
  that contain `show_me` calls give real questions paired with the tour the large model
  wrote, which can be checked by hand once and then reused for every option. Score options
  A, B and C on the same set.

## Keeping up with UI changes

The desktop app changes often, so a model that memorises command ids goes stale.

- **Retrieve at inference.** Give the model the candidate commands in its prompt, and
  train it to choose among what it is shown. A renamed or new command then needs a
  regenerated index, not a retrained model.
- **Constrain to the live registry.** Build the decoding grammar from the registry at
  startup, so a removed command cannot be produced.
- **Retrain on a signal.** When a `pnpm gen:uxmodel` diff adds or renames commands,
  regenerate the training questions for those records and rerun the evaluation. Retrain
  only when the score drops.
- **Options A and B need none of this.** Their only input is the regenerated index.

## Recommendation

1. **Build the evaluation set first.** Gather 100–200 real questions with checked answers.
   Without it there is no way to compare the options.
2. **Build option A.** It is a few days of work, has no running cost, and its index and
   shortlist are inputs to both other options.
3. **Add option B behind it** for questions where option A's top match scores low, or when
   the author asks for more than one step. Use the retrieved shortlist rather than the
   whole catalog.
4. **Consider option C only if** the evaluation shows a gap that matters and one of these
   holds: the helper must work offline, the per-question cost of option B is too high, or
   option B is too slow. Start from FunctionGemma 270M or Qwen3 0.6B with SFT on generated
   questions, constrained decoding and retrieved candidates in the prompt. Add GRPO with
   the reward above only if SFT plateaus.

## Open questions

- Should the helper be a separate entry point (a palette-like "Ask how" box) or a mode of
  the existing agent conversation? A separate box avoids carrying the authoring agent's
  context, which is most of the current latency.
- What latency counts as fast enough? The answer decides between options B and C.
- Should option A's shortlist show without the author confirming, or should a
  high-confidence match start the tour immediately?
- Where does the encoder live? Shared with `@vn/bible` (per
  [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md)) or owned by the desktop app? The
  layering rules decide whether sharing is allowed.

## Sources

- [FunctionGemma release coverage, InfoQ](https://infoq.com/news/2026/01/functiongemma-edge-function-call)
- [FunctionGemma, edge-ai-vision.com](https://www.edge-ai-vision.com/?p=56302)
- [functiongemma-270m-it ONNX build](https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX)
- [Advancing SLM tool-use capability using reinforcement learning (arXiv 2509.04518)](https://arxiv.org/html/2509.04518v2)
- [RL-Tool-Calling: GRPO with TRL and Unsloth](https://github.com/MDadopoulos/RL-Tool-Calling)
- [Qwen3-0.6B trained with SFT then GRPO on tool calling](https://huggingface.co/iromu/Qwen3-0.6B-tools-RL-step25)
- [Anthropic Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)
