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
