# Manga style: live-model tests

The live checks the [manga-style plan](../plans/manga-style.md#live-model-testing) asks
for, one section per stage, run against real models after the stage's mock tests were
green. Each section records what was drawn, on which models, what came back, and what it
cost. The decisions each run settled are copied into the plan's As-shipped section.

Model ids churn; the tables record the ids that were listed on the day.

## Stage 1 — aspect is honoured (2026-09-14)

### What was checked

- One shot from `templates/basic`, `arrival/arrival__establishing`, drawn with no
  references at `16:9`, `3:4` and `9:16`. The prompt is the one `buildShotPrompt` makes,
  quoted below the list.
- The built-in Gemini backend (`createGeminiImage`, `gemini-2.5-flash-image`) drawn
  direct, and every model `GET /api/v1/images/models` listed on OpenRouter (52) drawn
  through the plugin's own `drawWithOpenRouter`, four calls in flight at a time.
- The check is the returned picture's pixel size read from its bytes (PNG `IHDR`, JPEG
  `SOF`, WebP `VP8`/`VP8L`/`VP8X`, and the root element's `width`/`height` for an SVG),
  never a look. The error column is `|w/h − asked| / asked`. A refusal is recorded with
  the status and the provider's own sentence.
- Not a bound graph: the plan's harness section describes binding one graph per model to a
  slot, which Stage 2 and Stage 4 need because they run the pipeline. Stage 1 needs only
  bytes, so a scratch driver bundled the repo's own backend, the plugin's draw function
  and `buildShotPrompt` with `scripts/aliases.mjs`, and called them directly. Keys went
  through `resolveKeys`; nothing printed one.

> Art style: soft anime visual-novel illustration, cel shaded, warm lighting. establishing
> shot in Classroom 2-B (day). Subjects: Aiko, wearing navy winter school uniform, pleated
> skirt, worn satchel of enamel pins. Render as a single illustrated frame, no UI text.

### Budget and spend

- `vngen cost templates/basic` before the run: 6 image calls pending at the P3 gate (4
  `location_ref`, 2 `portrait`), none of which this check runs.
- Per-model prices came from `GET /api/v1/images/models/{id}/endpoints` beforehand; the
  estimate for 52 models × 3 was about $14.
- Spent
  $9.61 on OpenRouter across 156 calls (`usage.cost` summed), plus nine direct
  Gemini calls the API does not price; at Google's published rate they are about $0.04
  each, so about $0.35. The most expensive rows are Recraft's pro tiers at $0.21–$0.30 per
  picture.
- Latency through OpenRouter: median 21 s per picture, 3 s at best, 88 s at worst.

### The built-in backend did not send the ratio

- With the pinned `@google/genai@0.3.1`, the backend that commit 3ecd62b5 taught to send
  `imageConfig: { aspectRatio }` returned **1024×1024 for all three ratios**. That SDK's
  `generateContentConfigToMldev` copies a fixed list of config fields onto the wire, and
  `imageConfig` is not on it, so the field was dropped before the request left the
  process. The pipeline's `16:9` has therefore never reached Gemini through the built-in
  backend, on any version of this code.
- The same backend code with `@google/genai@2.22.0` injected through the `GeminiClient`
  seam returned 1344×768, 864×1184 and 768×1344. That is the fix: the SDK bump, not the
  backend. After the bump landed in the lockfile, `createImageBackend` through the repo's
  own install returned the same three sizes.

| Backend                                             | 16:9                    | 3:4                     | 9:16                    |
| --------------------------------------------------- | ----------------------- | ----------------------- | ----------------------- |
| `gemini-2.5-flash-image`, `@google/genai` 0.3.1     | 1024×1024 (wrong shape) | 1024×1024 (wrong shape) | 1024×1024 (wrong shape) |
| `gemini-2.5-flash-image`, `@google/genai` 2.22.0    | 1344×768 png (1.6%)     | 864×1184 png (2.7%)     | 768×1344 png (1.6%)     |
| the same, through the repo's install after the bump | 1344×768 png (1.6%)     | 864×1184 png (2.7%)     | 768×1344 png (1.6%)     |

### OpenRouter, model by model

The "Declares" column is what `supported_parameters.aspect_ratio.values` listed for the
model, in the order 16:9, 3:4, 9:16.

| Model                                   | Provider                     | Declares 16:9 3:4 9:16 | 16:9                                        | 3:4                                         | 9:16                                        | Spend  |
| --------------------------------------- | ---------------------------- | ---------------------- | ------------------------------------------- | ------------------------------------------- | ------------------------------------------- | ------ |
| `openai/gpt-image-2.5-sunburst`         | openai                       | ✓ ✓ ✓                  | 1536×864 png (0.0%)                         | 1152×1536 png (0.0%)                        | 864×1536 png (0.0%)                         | $0.115 |
| `openai/gpt-image-2.5-flare`            | openai                       | ✓ ✓ ✓                  | 1536×864 png (0.0%)                         | 1152×1536 png (0.0%)                        | 864×1536 png (0.0%)                         | $0.069 |
| `microsoft/mai-image-2.6`               | azure                        | ✓ ✓ ✓                  | 1360×768 png (0.4%)                         | 768×1024 png (0.0%)                         | 768×1360 png (0.4%)                         | $0.108 |
| `microsoft/mai-image-2.6-flash`         | azure                        | ✓ ✓ ✓                  | 1360×768 png (0.4%)                         | 768×1024 png (0.0%)                         | 768×1360 png (0.4%)                         | $0.054 |
| `meta/muse-image`                       | —                            | ✗ ✗ ✗                  | refused 403: 18+ confirmation required      | refused 403: 18+ confirmation required      | refused 403: 18+ confirmation required      | —      |
| `recraft/recraft-v4-styles-pro`         | recraft                      | ✓ ✓ ✓                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `recraft/recraft-v4-styles-vector`      | recraft                      | ✓ ✓ ✓                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `recraft/recraft-v4-styles-pro-vector`  | recraft                      | ✓ ✓ ✓                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `recraft/recraft-v4-styles`             | recraft                      | ✓ ✓ ✓                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `bytedance-seed/seedream-5-0-lite`      | seed                         | ✓ ✓ ✓                  | 3642×2048 jpeg (0.0%)                       | 2048×2732 jpeg (0.0%)                       | 2048×3642 jpeg (0.0%)                       | $0.105 |
| `bytedance-seed/seedream-5-0-pro`       | seed                         | ✓ ✓ ✓                  | 2048×1152 jpeg (0.0%)                       | 1536×2048 jpeg (0.0%)                       | 1152×2048 jpeg (0.0%)                       | $0.180 |
| `x-ai/grok-imagine-image-2.0`           | xai                          | ✓ ✓ ✓                  | 1280×720 jpeg (0.0%)                        | 864×1152 jpeg (0.0%)                        | 720×1280 jpeg (0.0%)                        | $0.180 |
| `qwen/qwen-image-3-pro`                 | alibaba                      | ✓ ✓ ✓                  | 1822×1024 png (0.1%)                        | 1024×1366 png (0.0%)                        | 1024×1822 png (0.1%)                        | $0.120 |
| `qwen/qwen-image-3`                     | alibaba                      | ✓ ✓ ✓                  | 1822×1024 png (0.1%)                        | 1024×1366 png (0.0%)                        | 1024×1822 png (0.1%)                        | $0.090 |
| `microsoft/mai-image-2.5-pro`           | azure                        | ✓ ✓ ✓                  | 1360×768 png (0.4%)                         | 768×1024 png (0.0%)                         | 768×1360 png (0.4%)                         | $0.304 |
| `krea/krea-2-large`                     | krea                         | ✓ ✗ ✓                  | 1376×768 png (0.8%)                         | refused 400: no provider supports the ratio | 768×1376 png (0.8%)                         | $0.120 |
| `krea/krea-2-medium`                    | krea                         | ✓ ✗ ✓                  | 1376×768 png (0.8%)                         | refused 400: no provider supports the ratio | 768×1376 png (0.8%)                         | $0.060 |
| `krea/krea-2-medium-turbo`              | krea                         | ✓ ✗ ✓                  | 1376×768 png (0.8%)                         | refused 400: no provider supports the ratio | 768×1376 png (0.8%)                         | $0.030 |
| `google/gemini-3.1-flash-lite-image`    | google-vertex/global         | ✓ ✓ ✓                  | 1376×768 jpeg (0.8%)                        | 896×1200 jpeg (0.4%)                        | 768×1376 jpeg (0.8%)                        | $0.101 |
| `openai/gpt-image-2`                    | openai                       | ✓ ✓ ✓                  | 1536×864 png (0.0%)                         | 1152×1536 png (0.0%)                        | 864×1536 png (0.0%)                         | $0.087 |
| `openai/gpt-image-1-mini`               | openai                       | ✗ ✗ ✗                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `openai/gpt-image-1`                    | openai                       | ✗ ✗ ✗                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `google/gemini-3.1-flash-image`         | google-ai-studio             | ✓ ✓ ✓                  | 1376×768 png (0.8%)                         | 896×1200 png (0.4%)                         | 768×1376 png (0.8%)                         | $0.202 |
| `google/gemini-3-pro-image`             | google-ai-studio/global      | ✓ ✓ ✓                  | 1376×768 png (0.8%)                         | 896×1200 png (0.4%)                         | 768×1376 png (0.8%)                         | $0.404 |
| `sourceful/riverflow-v2.5-pro`          | sourceful                    | ✓ ✓ ✓                  | 1280×720 webp (0.0%)                        | 864×1152 webp (0.0%)                        | 720×1280 webp (0.0%)                        | $0.129 |
| `sourceful/riverflow-v2.5-fast`         | sourceful                    | ✓ ✓ ✓                  | 1024×576 webp (0.0%)                        | 768×1024 webp (0.0%)                        | 576×1024 webp (0.0%)                        | $0.057 |
| `microsoft/mai-image-2.5`               | azure                        | ✓ ✓ ✓                  | 1360×768 png (0.4%)                         | 768×1024 png (0.0%)                         | 768×1360 png (0.4%)                         | $0.133 |
| `x-ai/grok-imagine-image-quality`       | xai                          | ✓ ✓ ✓                  | 1280×720 jpeg (0.0%)                        | 864×1152 jpeg (0.0%)                        | 720×1280 jpeg (0.0%)                        | $0.150 |
| `recraft/recraft-v4.1-pro-vector`       | recraft                      | ✓ ✓ ✓                  | 2688×1536 svg (1.6%)                        | 1792×2432 svg (1.8%)                        | 1536×2688 svg (1.6%)                        | $0.900 |
| `recraft/recraft-v4.1-vector`           | recraft                      | ✓ ✓ ✓                  | 1344×768 svg (1.6%)                         | 896×1216 svg (1.8%)                         | 768×1344 svg (1.6%)                         | $0.240 |
| `recraft/recraft-v4.1-utility-pro`      | recraft                      | ✓ ✓ ✓                  | 2688×1536 webp (1.6%)                       | 1792×2432 webp (1.8%)                       | 1536×2688 webp (1.6%)                       | $0.630 |
| `recraft/recraft-v4.1-utility`          | recraft                      | ✓ ✓ ✓                  | 1344×768 webp (1.6%)                        | 896×1216 webp (1.8%)                        | 768×1344 webp (1.6%)                        | $0.105 |
| `recraft/recraft-v4.1-pro`              | recraft                      | ✓ ✓ ✓                  | 2688×1536 webp (1.6%)                       | 1792×2432 webp (1.8%)                       | 1536×2688 webp (1.6%)                       | $0.630 |
| `recraft/recraft-v4.1`                  | recraft                      | ✓ ✓ ✓                  | 1344×768 webp (1.6%)                        | 896×1216 webp (1.8%)                        | 768×1344 webp (1.6%)                        | $0.105 |
| `recraft/recraft-v4-pro-vector`         | recraft                      | ✓ ✓ ✓                  | 2688×1536 svg (1.6%)                        | 1792×2432 svg (1.8%)                        | 1536×2688 svg (1.6%)                        | $0.900 |
| `recraft/recraft-v4-vector`             | recraft                      | ✓ ✓ ✓                  | 1344×768 svg (1.6%)                         | 896×1216 svg (1.8%)                         | 768×1344 svg (1.6%)                         | $0.240 |
| `recraft/recraft-v4-pro`                | recraft                      | ✓ ✓ ✓                  | 2688×1536 webp (1.6%)                       | 1792×2432 webp (1.8%)                       | 1536×2688 webp (1.6%)                       | $0.750 |
| `recraft/recraft-v4`                    | recraft                      | ✓ ✓ ✓                  | 1344×768 webp (1.6%)                        | 896×1216 webp (1.8%)                        | 768×1344 webp (1.6%)                        | $0.120 |
| `recraft/recraft-v3`                    | recraft                      | ✓ ✓ ✓                  | 1820×1024 webp (0.0%)                       | 1024×1365 webp (0.0%)                       | 1024×1820 webp (0.0%)                       | $0.120 |
| `openai/gpt-5.4-image-2`                | openai                       | ✓ ✓ ✓                  | 1536×864 png (0.0%)                         | 1152×1536 png (0.0%)                        | 864×1536 png (0.0%)                         | $0.070 |
| `google/gemini-3.1-flash-image-preview` | google-ai-studio             | ✓ ✓ ✓                  | 1376×768 jpeg (0.8%)                        | 896×1200 jpeg (0.4%)                        | 768×1376 jpeg (0.8%)                        | $0.206 |
| `sourceful/riverflow-v2-pro`            | sourceful                    | ✓ ✓ ✓                  | 1280×720 webp (0.0%)                        | 864×1152 webp (0.0%)                        | 720×1280 webp (0.0%)                        | $0.450 |
| `sourceful/riverflow-v2-fast`           | sourceful                    | ✓ ✓ ✓                  | 1024×576 webp (0.0%)                        | 768×1024 webp (0.0%)                        | 576×1024 webp (0.0%)                        | $0.060 |
| `black-forest-labs/flux.2-klein-4b`     | black-forest-labs            | ✓ ✓ ✓                  | 1824×1024 jpeg (0.2%)                       | 1024×1376 jpeg (0.8%)                       | 1024×1824 jpeg (0.2%)                       | $0.045 |
| `bytedance-seed/seedream-4.5`           | seed                         | ✓ ✓ ✓                  | 3642×2048 jpeg (0.0%)                       | 2048×2732 jpeg (0.0%)                       | 2048×3642 jpeg (0.0%)                       | $0.120 |
| `black-forest-labs/flux.2-max`          | black-forest-labs/us-3       | ✓ ✓ ✓                  | 1824×1024 jpeg (0.2%)                       | 1024×1376 jpeg (0.8%)                       | 1024×1824 jpeg (0.2%)                       | $0.300 |
| `black-forest-labs/flux.2-flex`         | black-forest-labs/us-3       | ✓ ✓ ✓                  | 1824×1024 jpeg (0.2%)                       | 1024×1376 jpeg (0.8%)                       | 1024×1824 jpeg (0.2%)                       | $0.300 |
| `black-forest-labs/flux.2-pro`          | black-forest-labs            | ✓ ✓ ✓                  | 1824×1024 jpeg (0.2%)                       | 1024×1376 jpeg (0.8%)                       | 1024×1824 jpeg (0.2%)                       | $0.135 |
| `google/gemini-3-pro-image-preview`     | google-ai-studio/global/flex | ✓ ✓ ✓                  | 1376×768 jpeg (0.8%)                        | 896×1200 jpeg (0.4%)                        | 768×1376 jpeg (0.8%)                        | $0.273 |
| `openai/gpt-5-image-mini`               | openai                       | ✗ ✗ ✗                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `openai/gpt-5-image`                    | openai                       | ✗ ✗ ✗                  | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | refused 400: no provider supports the ratio | —      |
| `google/gemini-2.5-flash-image`         | google-ai-studio/priority    | ✓ ✓ ✓                  | 1344×768 png (1.6%)                         | 864×1184 png (2.7%)                         | 768×1344 png (1.6%)                         | $0.116 |

### What the table says

- **40 of 52 models honoured all three ratios**, every one within 3% of the asked shape.
  No model returned a wrong-shaped picture: every miss was a refusal, which is the
  property the plan asked for.
- **Every refusal arrived as a provider error the plugin quoted.** OpenRouter answers a
  ratio nobody serves with `400` and the sentence
  `No provider for <model> supports the requested parameter(s): aspect_ratio "3:4"`, and
  the plugin's error carries it. Nothing fell through to a default-shaped picture.
- **The listing over-promises for four models.** Recraft's four `styles` models declare
  all three ratios in `supported_parameters` and refuse all three at the endpoint.
  Everywhere else the listing and the endpoint agreed: Krea declares no `3:4` and refuses
  it; OpenAI's `gpt-image-1`, `gpt-image-1-mini`, `gpt-5-image` and `gpt-5-image-mini`
  declare only `1:1`, `3:2` and `2:3` and refuse all three asked ratios. A caller who
  wants to know whether a model will draw a ratio has to ask the endpoint, not the list.
- **Google's models snap to token-friendly sizes**: 1376×768 for 16:9, 896×1200 for 3:4,
  768×1376 for 9:16 on the 3.x models, and 1344×768 / 864×1184 / 768×1344 on 2.5. That is
  a 0.4%–2.7% departure from the asked ratio, the largest in the table; OpenAI, Seedream,
  Grok, Qwen, Riverflow and Recraft v3 land exactly on it.
- **Four Recraft `vector` models answer with an SVG** (`image/svg+xml`, C2PA manifest in
  the metadata). The plugin passes it through with `ext: 'svg+xml'`, which nothing
  downstream can read; a vector model is unfit for the pipeline regardless of ratio. Not
  changed in Stage 1.
- `meta/muse-image` is behind an 18+ confirmation on the account and was not drawn.

### Decisions settled

- The built-in backend honours `image_params.aspect` and a shot's `aspect` only once
  `@google/genai` is at a version whose config converter carries `imageConfig`. Stage 1
  bumps it to 2.22.0; the three direct calls above are the proof.
- The OpenRouter plugin needs no change for Stage 1: it sends `aspect_ratio`, and a
  refusal reaches the caller with the provider's reason.
- For Stage 2's page shots, `3:4` is served by 40 of the 52 listed models (all but Krea's
  three, the four Recraft `styles` models, the four older OpenAI models and `muse-image`),
  and every one that serves it lands within 2.7% of the shape. Nothing here argues against
  `3:4` as the default `page_aspect`.

## Stage 2 — layout and lettering (2026-09-15)

### What was checked

- Pages of `templates/basic`'s `rooftop` scene (seven lines, two characters), one per
  layout template at the template's own panel count, each panel lettering one line: the
  two-panel `diagonal-split` (L2, L3), the three-panel splash (L1–L3), the four-panel
  `two-tier` (L1–L4), the six-panel `three-tier` (L1–L6), and an eight-panel `evenLayout`
  page (L1–L7, one panel silent) past the bound the decomposer is told. The prompt is the
  one `buildShotPrompt` makes for a page under `lettering: model`; the four-panel one is
  quoted below the list.
- Ten models: the built-in Gemini backend (`gemini-2.5-flash-image`, direct) and nine
  through the OpenRouter plugin's `drawWithOpenRouter`, chosen from Stage 1's table to
  span the vendors that serve `3:4` and to fit the budget. Per model, the four templates
  at three seeds at `3:4`, `two-tier` at two seeds at `2:3`, and the eight-panel page
  once: 15 pages, 150 in all.
- Every page was reviewed by the pipeline's own two reviewers (`gemini-2.5-flash` and
  `claude-opus-4-8` through `ChatVisionReviewer`, with the page's `shotSpec` under
  `lettering: model` and no references), so the two numbers come from what the stage
  ships: the layout-honoured rate is the reviewer's `observed` boxes matched to the
  intended outlines by `matchPanels` at `LAYOUT_IOU`, and the lettering exact-match rate
  is a review with no `lettering` defect. First-attempt acceptance is the runner's rule:
  no blocking defect from either reviewer and the layout honoured.
- A scratch driver again, not a bound graph: the same `run.mjs` as Stage 1, bundling the
  repo's own prompt builder, backend, plugin and reviewers. Keys went through
  `resolveKeys`; nothing printed one. The full P7 refine loop was not run (150 pages at up
  to four attempts each would have quadrupled the spend), so attempts-to-accept is
  reported as first-attempt acceptance rather than measured.

> Art style: soft anime visual-novel illustration, cel shaded, warm lighting. A manga page
> of 4 panels in School Rooftop (evening). Layout: panel 1: roughly square, top-left;
> panel 2: roughly square, top-right; panel 3: roughly square, bottom-left; panel 4:
> roughly square, bottom-right. Panel 1 (wide shot): Aiko, wearing navy winter school
> uniform, pleated skirt, worn satchel of enamel pins; Haruki, wearing uniform. camera:
> eye level. Panel 2 (medium shot): Aiko, wearing navy winter school uniform, pleated
> skirt, worn satchel of enamel pins. Panel 3 (close shot): Haruki, wearing uniform. Panel
> 4 (medium shot): Aiko, wearing navy winter school uniform, pleated skirt, worn satchel
> of enamel pins; Haruki, wearing uniform. Lettering, verbatim: panel 1: caption "Aiko
> pushes through the heavy door to find the rooftop already occupied. Haruki leans against
> the fence, hands in his pockets, watching the courtyard lights flicker on."; panel 2:
> Aiko says "Oh — sorry. I didn't think anyone came up here."; panel 3: Haruki says "Most
> people don't. That's the appeal."; panel 4: caption "He glances at her, then back to the
> view. Aiko hesitates, then steps up beside him.". Render as one complete comic page with
> drawn panel borders; no UI text.

### Budget and spend

- `vngen cost templates/basic` before the run: 6 image calls pending at the P3 gate (4
  `location_ref`, 2 `portrait`), none of which this check runs; unchanged after, since the
  check never touches the project.
- Estimated from Stage 1's per-model prices: about $8 of images plus the reviews.
- Spent
  $9.50 on OpenRouter across 150 calls (`usage.cost` summed; the table has each
  model's share), plus 15 direct Gemini calls at about $0.04
  each, so about
  $0.60. The 292
  review calls are not priced by either API; at published rates they are roughly $6,
  nearly all of it Claude.
- Latency through OpenRouter: median 47 s per page, 9 s at best, 154 s at worst. A page is
  slower than a frame everywhere; the OpenAI and Grok models take a minute or two each.
  Reviews: Claude 5 s median, Gemini 15 s.

### Per model (the four templates, three seeds, at 3:4)

"Either" is the runner's verdict, below; the two reviewer columns are each reviewer's own
boxes. Spend is the model's 15 pages together.

| Model                             | Pages | Layout honoured (either) | gemini | claude | Lettering exact (gemini) | (claude) | Accepted first try | Median s | Spend             |
| --------------------------------- | ----- | ------------------------ | ------ | ------ | ------------------------ | -------- | ------------------ | -------- | ----------------- |
| `gemini-2.5-flash-image` (direct) | 12    | 83%                      | 75%    | 75%    | 8%                       | 8%       | 8%                 | 7        | —                 |
| `google/gemini-3.1-flash-image`   | 12    | 75%                      | 67%    | 67%    | 58%                      | 58%      | 42%                | 11       | $1.01             |
| `google/gemini-3-pro-image`       | 12    | 92%                      | 83%    | 92%    | 92%                      | 92%      | 92%                | 25       | $2.03             |
| `openai/gpt-image-2`              | 12    | 100%                     | 100%   | 83%    | 100%                     | 100%     | 100%               | 49       | $1.33             |
| `openai/gpt-image-2.5-sunburst`   | 12    | 100%                     | 92%    | 75%    | 100%                     | 100%     | 92%                | 38       | $1.33             |
| `bytedance-seed/seedream-5-0-pro` | 12    | 100%                     | 83%    | 92%    | 67%                      | 42%      | 50%                | 78       | $1.35             |
| `x-ai/grok-imagine-image-2.0`     | 12    | 100%                     | 83%    | 100%   | 100%                     | 100%     | 100%               | 100      | $0.90             |
| `qwen/qwen-image-3-pro`           | 12    | 100%                     | 92%    | 100%   | 75%                      | 42%      | 33%                | 69       | $0.60             |
| `black-forest-labs/flux.2-pro`    | 8     | 63%                      | 38%    | 50%    | 13%                      | 13%      | 0%                 | 22       | $0.49 (4 refused) |
| `microsoft/mai-image-2.6`         | 12    | 100%                     | 92%    | 100%   | 17%                      | 17%      | 17%                | 26       | $0.47             |

### Per template (all models, at 3:4)

The splash row is scored against the outline the template now has (see below).

| Template          | Panels | Pages | Layout honoured (either) | gemini | claude | Lettering exact (gemini) | (claude) | Accepted first try |
| ----------------- | ------ | ----- | ------------------------ | ------ | ------ | ------------------------ | -------- | ------------------ |
| `diagonal-split`  | 2      | 30    | 97%                      | 93%    | 80%    | 77%                      | 73%      | 70%                |
| `splash-over-two` | 3      | 29    | 100%                     | 90%    | 100%   | 66%                      | 59%      | 55%                |
| `two-tier`        | 4      | 28    | 86%                      | 75%    | 82%    | 64%                      | 57%      | 54%                |
| `three-tier`      | 6      | 29    | 86%                      | 69%    | 76%    | 52%                      | 45%      | 41%                |
| `evenLayout(8)`   | 8      | 10    | 70%                      | 60%    | 50%    | 50%                      | 40%      | 40%                |

### The ratio, the threshold and the reviewers

| `two-tier` at | Pages | Layout honoured (either) | Lettering exact (gemini) | (claude) | Accepted first try |
| ------------- | ----- | ------------------------ | ------------------------ | -------- | ------------------ |
| `3:4`         | 28    | 86%                      | 64%                      | 57%      | 54%                |
| `2:3`         | 20    | 80%                      | 60%                      | 50%      | 40%                |

| IoU threshold | Layout honoured (either) | gemini | claude |
| ------------- | ------------------------ | ------ | ------ |
| 0.3           | 95%                      | 91%    | 86%    |
| 0.4           | 94%                      | 84%    | 85%    |
| 0.5           | 92%                      | 82%    | 84%    |
| 0.6           | 85%                      | 75%    | 68%    |
| 0.7           | 74%                      | 66%    | 49%    |

- The two reviewers gave the same layout verdict on 95 of 116 pages and the same lettering
  verdict on 109 of 116.
- A drawn panel's median overlap with its intended box is 0.88–0.94 on `two-tier`,
  0.74–0.87 on `three-tier`, 0.66–0.78 on `diagonal-split` (the bounding boxes of the two
  slanted panels overlap each other, so the ceiling is lower) and 0.70–0.92 on the
  eight-panel page.

### What the tables say

- **Nobody draws a splash with insets.** The template as designed (a full-page splash with
  two small panels floating over its lower corners) was drawn by none of the ten models on
  any of 29 pages: every one drew a splash across the top half to two thirds over a row of
  two, with nothing overlapping. The panel count was right on 28 of 29, so this is the
  layout being refused, not the measurement. The template is now that page,
  `splash-over-two` (`rect(0, 0, 1, 0.6)` over two `0.5 × 0.4` panels), and against that
  outline the same 29 pages are honoured 100% (either reviewer).
- **The Gemini reviewer sometimes measures against the wrong edge.** On seven six-panel
  pages its boxes ended at 0.74 of the page height, rows of 0.24 apiece, while Claude's
  ended at 1.0; the page was laid out correctly. A reviewer's miss is therefore not proof
  of a wrong layout, while no reviewer produced well-matched boxes for a page that was
  wrong, so the runner now honours a page when any measuring reviewer's boxes match. That
  is the "either" column, and it lifts the honoured rate from about 82% (either reviewer
  alone) to 92% at the same threshold.
- **The threshold is 0.5.** Honoured rates hold from 0.3 to 0.5 (95% to 92%) and fall away
  above it (85% at 0.6, 74% at 0.7), because a drawn gutter and the reviewer's imprecision
  cost every box a few percent and the slanted template's boxes overlap by design. Below
  0.5 a box from the neighbouring tier starts to qualify.
- **Six panels is the bound.** Layout holds to six (86%) and lettering falls steadily with
  the count (77% exact at two panels, 52% at six, 50% at eight from ten pages); the
  eight-panel page is honoured 70% and accepted 40%. The bound the decomposer is told
  stays at six.
- **`3:4` stays the default `page_aspect`.** `2:3` was not better on any number (80%
  versus 86% honoured, 40% versus 54% accepted, on 20 versus 28 pages).
- **Lettering is where the models divide.** Four letter a page exactly nearly every time:
  `gpt-image-2` and `grok-imagine-image-2.0` (100%), `gpt-image-2.5-sunburst` (100%) and
  `gemini-3-pro-image` (92%). `seedream-5-0-pro` and `qwen-image-3-pro` draw the layout
  every time and misspell a word or two on half their pages ("AGAIINST", "courtyord").
  Three are unfit for lettered pages: the built-in `gemini-2.5-flash-image` (8% exact,
  garbled captions throughout), `mai-image-2.6` (17%) and `flux.2-pro` (13%, and
  OpenRouter refused 4 of its 15 pages through Black Forest Labs' content moderation for a
  prompt about two students on a school rooftop). Their layouts are fine, so under
  `lettering: runner`, which draws no text, they would be ordinary; the finding is about
  model lettering, and it means the default image model letters pages it cannot pass.
- **Long captions fail first.** Panel 1's 28-word narration caption is the line most often
  garbled or truncated; dialogue of a dozen words is nearly always exact on the models
  that letter at all. A decomposer that keeps a panel's lettering short will pass more
  pages.
- Blocking defects other than lettering and layout were few (a missing character on 23
  reviews, a framing miss on 4) and are the ordinary frame review, not a page problem.

### Decisions settled

- `page_aspect` defaults to `3:4`.
- `LAYOUT_IOU` stays `0.5`.
- `MAX_PANELS` stays 6.
- `splash-with-insets` is replaced by `splash-over-two`, the page every model draws when
  asked for the former.
- The runner's layout verdict trusts a match from any measuring reviewer, and the planner
  stamps that reviewer's boxes as `panelBoxes`.
- Under `lettering: model`, `gemini-2.5-flash-image`, `mai-image-2.6` and `flux.2-pro` are
  unfit for pages. The project default image model is the first of those, so a project
  that wants lettered pages today should draw them through OpenRouter on one of the four
  that pass (by naming its `<vendor>/<model>` id in `models.image` or on a node; the
  plugin the check ran through has since been retired), or wait for `lettering: runner`.

## Image model default — OpenRouter as a backend (2026-09-15)

The live check the
[OpenRouter-backend plan](../plans/archive/openrouter-backend-and-the-image-model-default.md#live-check)
asks for, run on the branch after Stages 1 to 5 were green.

### What was checked

- A copy of `templates/basic` with `models.image: openai/gpt-image-2` and its own `keys/`,
  run through the CLI built from the branch: `vngen cost`, a run with the OpenRouter key
  withheld, the run to the P3 gate, `vngen approve --yes`, and the run past it. The check
  is each asset's `modelId` and pixel size read from the two manifests, and the reviewers'
  verdicts in `state/tasks.jsonl`.
- One graph, `GenDerivedPrompt` and `GenTaskRefs` feeding a `GenImage` into a `GenOutput`
  bound to `shot:ending/ending__s1`, written from the DSL, run three times on the same
  slot: with `model` empty, with `model: gemini-2.5-flash-image`, and empty again. The
  check is the run journal's `draw` records and the manifest.
- The inherit graph's node hashes under two project models and none, computed from the
  graph doc the run used (`graphHashes` with `defaults.imageModel`).
- One catalog refresh against the live endpoints, timed, through
  `listOpenRouterImageModels` with a counting `fetch`.

### Budget and spend

- `vngen cost` before the first run: 6 image calls at the P3 gate (4 `location_ref`, 2
  `portrait`); after approval, 13 tasks (6 `model_sheet`, 7 `shot_image`) at an upper
  bound of 34 image calls and 56 review calls.
- OpenRouter's key meter read $37.317 after the P3 run and $38.008 at the end:
  $0.61 for
  the 17 pictures past the gate (about $0.036 each on `gpt-image-2` at 16:9,
  against $0.0885 for a 3:4 page in Stage 2) and $0.08 for the three graph draws. The
  eight pictures before the first reading are estimated at
  $0.29 from the same rate, so about
  **$0.98 on OpenRouter** across 28 pictures, plus one
  direct Gemini draw (about $0.04),
  34 review calls (about $0.70) and two scene
  decompositions on Claude (under $0.10).
  About $1.80 in all; the plan estimated $0.60
  for a run stopping after one shot, and the post-gate wave was run whole because the
  model sheets are the edit path.
- Latency: the P3 run took 67 s for 8 pictures at concurrency 4; the post-gate wave 5 m 48
  s for 17 pictures with 26 reviews. A catalog refresh took 2.7 s for 53 calls.

### What came back

- With `keys/openrouter.txt` moved aside, `vngen run` refused before decomposing or
  drawing:
  `missing openrouter API key: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir`,
  exit 1. Nothing was written.
- Every one of the 25 pipeline assets says `modelId: openai/gpt-image-2` and is 1536×864
  PNG, the exact 16:9 the project asked for: 4 location refs, 2 portraits, 6 model sheets
  (reference-guided edits through the same endpoint, base first) and 13 shots. All 13
  shots were accepted on the first attempt by both reviewers.
- The graph on the same slot: `model: ''` drew through OpenRouter with
  `modelId: openai/gpt-image-2` (two attempts, the second after a critique, then
  accepted); `model: gemini-2.5-flash-image` was reported as
  `drifted: live-inherit node out` by `vngen status`, redrawn on the next run direct
  through Gemini (`modelId: gemini-2.5-flash-image`, 1344×768); empty again redrew through
  OpenRouter. The pictures drawn through the graph are 1672×941 and 1344×768 rather than
  16:9, because a graph node's `aspect` prop is what it sends and the test graph left it
  empty.
- The flip back to `''` redrew rather than resumed, although a `done` record with that
  exact hash was in the journal: `executeGenGraph` resumes from the node's latest record
  only, and the latest was the Gemini one. That was the rule at the time, and it erred
  toward a redraw. Since fixed: the journal now resumes from any answer it holds for the
  same run key
  ([`../plans/archive/journal-content-cache.md`](../plans/archive/journal-content-cache.md)).
- The hashes, from the graph doc: `refs` and `prompt` are the same under every default;
  `draw` and `out` differ between `openai/gpt-image-2`, `google/gemini-2.5-flash-image`
  and no default at all. A change of `models.image` therefore reaches an inherit node's
  run hash, which is what keeps the journal from handing a re-keyed task the old picture.
- `vngen cost` on the bound slot said `no price for: openai/gpt-image-2`, which is right:
  the resolved id is a per-token model and the catalog carries no per-picture price for
  it. `vngen status` reported the drifted output, but `vngen cost` counted 0 slots to draw
  for it: a drifted slot was not in the graph estimate, only an unrendered one. Since
  fixed: `boundSlotsToDraw` prices the drifted bound slots beside the unrendered ones.
- The listing: 52 image models, every id with a slash, 26 with a per-picture price
  ($0.019
  to $0.30; ByteDance, Qwen, Recraft, Sourceful, xAI), 26 without (Black Forest
  Labs, Google, Krea, Meta, Microsoft, OpenAI, all billed per token or per megapixel), 12
  declaring a `seed` parameter, no endpoints call failed. 53 free calls, no key.

### Decisions settled

- OpenRouter as a built-in backend works end to end for every task kind, the edit path
  included, and the refusal for a missing key is the `resolveKeys` sentence before any
  spend.
- A per-token OpenRouter model stays unpriced in the estimate. The alternative, a nominal
  token count per picture, would put an unchecked figure beside checked ones.
- Nothing in the results changes the plan's decisions. Two things were noted for later
  work rather than fixed here: a drifted bound slot was not counted in `vngen cost`'s
  graph estimate (since fixed), and a graph node with an empty `aspect` draws at the
  provider's default size rather than the project's.
