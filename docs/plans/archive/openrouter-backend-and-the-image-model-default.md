# OpenRouter as a built-in image backend, and one image model to inherit from

**Status: shipped.** All six stages landed on 2026-09-15; the As-shipped section records
each stage's deviations and the live check's results. Written 2026-09-15 after the
manga-style Stage 2 live check found the default image model unfit for lettered pages
while three OpenRouter-routed models were not, and there was no way to say so in
`project.yaml` without a plugin graph on every slot. Pressure-tested the same day; the
findings and what changed are in the Review section.

## What this adds

- `models.image` may name an OpenRouter model (`openai/gpt-image-2`) as well as a Gemini
  one, and every image task and graph node draws through the right vendor without a
  plugin.
- A node's `model` prop may be left empty, which means the project's `models.image`. New
  nodes start empty. The picker's first entry says which model that is.
- The image-model pickers, in the Project editor and on the image nodes, list every image
  model OpenRouter routes to, from a cached listing refreshed on request, and open as a
  searchable list.
- `project.setImageModel` writes `models.image` the way `project.setArtStyle` writes
  `art_style`, counting the image tasks it re-keys.
- OpenRouter's models are priced, so the graph estimate (the desktop's run confirmation
  and `vngen cost`'s graph section) stops reporting "no price for `openai/gpt-image-2`".

## What this does not do

- Chat vendors, `models.text` and `models.vision`. Those stay with
  [`four-chat-vendors-and-two-more-image-providers.md`](../four-chat-vendors-and-two-more-image-providers.md).
- Direct OpenAI, xAI or BFL image backends. OpenRouter reaches those models already; a
  direct backend for one of them is that plan's Decision 7 and is not pre-empted here.
- A per-shot or per-scene image model. A graph bound to a slot is how one slot draws
  differently, and that is unchanged.
- Pricing unbound tasks in dollars. `vngen cost` counts calls for the task graph and
  prices only graph-bound slots (`apps/cli/src/commands.ts:359-402`); this plan adds a
  price table that section reads and does not add task pricing.
- The dollars ledger.
  [`provider-credentials-and-the-ai-usage-ledger.md`](../provider-credentials-and-the-ai-usage-ledger.md)
  owns spend accounting.

## Facts the plan rests on

- `models.image` exists, defaults to `gemini-2.5-flash-image`
  (`packages/types/src/schemas.ts:322`), is copied into every image task's
  `params.modelId` by `imageParams` (`packages/artgen/src/prompts.ts:39`), and is
  therefore in every image task's hash. Changing it re-keys the library the way
  `art_style` does.
- The built-in image backend is fixed to `config.models.image` at construction:
  `createImageBackend` is `createGeminiImage(keys.gemini, config.models.image)`
  (`packages/providers/src/factory.ts:44`), and `createGeminiImage`'s `run` sends its
  closed-over `modelId`, never `params.modelId` (`backends/gemini.ts:217`).
- So a `GenImage` or `GenEditImage` node's `model` prop reaches only the cost estimate.
  `imageParamsOf` puts it in `params.modelId`
  (`packages/gengraph/src/nodes/runtimes.ts:102`) and `createGenServices` hands the params
  to the same fixed backend (`packages/pipeline/src/genservices.ts:139`). A node naming
  any Gemini id has always drawn with the project's model.
- The node props default to the literal `'gemini-2.5-flash-image'`
  (`packages/gengraph/src/nodes/types.ts:229,271`). Their dropdown lists the keys of
  `SHIPPED_PRICES` that carry an `image` price (`types.ts:156`), which today is one id.
- A node's run hash is `type@typeVersion` plus its prop values plus its inputs
  (`packages/gengraph/src/hash.ts:16-24`). A graph's journal is per graph and keyed by
  node id (`packages/pipeline/src/graphrun.ts:239-263`); `executeGenGraph` returns a prior
  `done` record's output when the node hash is unchanged
  (`packages/gengraph/src/execute.ts:129-143`). A bumped `typeVersion` therefore changes
  every node of that type's hash, `graphDrift` reports every output, and `requeueDrifted`
  sends their tasks back to `pending` (`packages/scheduler/src/scheduler.ts:142-157`).
- `NodeMigration` renames inputs, outputs and props and rewrites placeholders
  (`packages/gengraph/src/registry.ts:44`); it runs in memory on load and never rewrites
  the file (`packages/gengraph/src/graphfile.ts:44-51`).
- `GenNodeEstimate` is `(props, { connected })` (`registry.ts:37`); `estimateGraph` builds
  the context (`packages/gengraph/src/cost.ts:49`); both hosts reach it through
  `reportGraphs` (`packages/pipeline/src/graphload.ts:174-191`,
  `apps/cli/src/commands.ts:240,362`) and the desktop also calls it directly
  (`apps/desktop/src/main/session/gengraph.ts:217`).
- `callWithRetry` retries a `RetryableProviderError` and any error whose `status`, `code`
  or `response.status` is a retryable number, or whose message names one after the word
  `status` or `code` (`packages/providers/src/backends/transient.ts:34-51,177-200`). A
  `ProviderError` a backend raises itself passes straight through. `faultKind` classes a
  `ConfigError` anywhere in the cause chain as `auth`, and a bare status at the head of a
  message as `auth` or `request` (`transient.ts:93-118`).
- `plugins/openrouter/` (manga-style Stage 1, commit `917c0e87`) is one `OpenRouterImage`
  node posting to `https://openrouter.ai/api/v1/images` with the `openrouter` key over
  `services.fetch`, references as data URLs, `provider: { data_collection: 'deny' }`,
  `aspect_ratio` and `seed` when set, and `usage.cost` read back
  (`plugins/openrouter/draw.ts`). Its sockets are `prompt`, `refs`, `refine` in and
  `image` out, and its props `model`, `aspect`, `seed`: the same names as `GenImage`. No
  graph in `examples/` or `templates/` uses it.
  `packages/gengraph/src/tests/openrouterplugin.test.ts` loads it from the repo root. An
  installed copy lives under `<user>/plugins/openrouter`
  (`packages/gengraph/src/pluginload.ts:20`). The plugin API does carry `customPropUX`
  (`packages/gengraph/src/plugin.ts:25` re-exports `NodeDef`).
- The `openrouter` key row already exists: `KEY_VENDORS`
  (`packages/config/src/keys.ts:12`), `OPENROUTER_API_KEY`, `keys/openrouter.txt`,
  `project.setKey`, `project.testKey` against `GET /api/v1/key`, and the key guide's
  OpenRouter section. Three comments say no built-in backend reads it: `keys.ts:9-11`,
  `packages/types/src/schemas.ts:335-338`, `docs/guides/api-keys.md:20-21,87`.
- `resolveKeys` is called with `require: ['gemini']` at five sites: the two `buildGenDeps`
  (`apps/desktop/src/main/session/core.ts:688`, `apps/cli/src/project.ts:88`), the
  desktop's `runPreconditions` (`apps/desktop/src/main/session/gengraph.ts:329`),
  `packages/testkit/src/record.ts:167`, and `packages/authoring/src/art.ts:112`.
  `record.ts:169` then builds `createGeminiImage(keys.gemini, config.models.image)`
  directly. `createProviders` builds the `models.vision` reviewers and the text model with
  no key check (`packages/providers/src/factory.ts:62-67`); the comment at
  `core.ts:684-685` saying they are "checked where they are built" has no code behind it.
- `CachedImageBackend` keys a recording on `params`, including `modelId`
  (`packages/providers/src/cache.ts:26-35`); the testkit wraps the stub or cached backend
  directly beneath graph services (`packages/testkit/src/project.ts:205-225`).
- `project.yaml` edits are byte-level splices of one top-level key (`withConfigKey`,
  `packages/config/src/config.ts:77`), re-parsed before they are written. `models.image`
  is nested under `models:`, which no splice handles yet. The schema accepts `''` for it.
- The Project editor is raw DOM in an `appendSurface` root fed by `exec('project.info')`
  (`apps/desktop/renderer/pathux/editors/project.ts:61-125`); it shows `models.image` as a
  read-only row (`project.ts:178`) and has one Apply for the art-style box, recorded by
  `applyStyleAction` in `renderer/rules/projectbar.ts`. It has no path.ux datapath, so
  `listenum` cannot draw in it; `container.menu` can, since it builds a `DropBox` over a
  `MenuTemplate` with no path.
- User-level state lives at `userConfigDir()`; the price table there is
  `<user>/prices.json`, written by `plugin.prices` with `affects: ['<user>/prices.json']`
  (`apps/desktop/src/main/commands/plugin.ts:103`, `packages/gengraph/src/pricestore.ts`).
  `<user>/<anything>` is already declarable and outside every snapshot
  (`apps/desktop/src/shared/affects.ts:39,104-119`). `hostPriceTables` orders the author's
  table, the shipped one, then plugin fragments
  (`packages/pipeline/src/graphload.ts:162`).
- `captureRequest` keeps request bodies in a ring the debug agent reads, bounded at 64 MB
  and 64 entries (`packages/providers/src/backends/capture.ts`). The Gemini image call
  does not capture; the plugin's `ringFetch` captures the whole body, base64 references
  included.
- path.ux `e5719970` gives `DropBox` an `autoSearchMode` attribute, on by default, so a
  `listenum` over more than fifteen entries opens as a filterable list; `container.menu`
  turns it off for menu bars and its argument-object form turns it back on for one.
- The Stage 2 live check (`docs/research/manga-live-tests.md`) drew through OpenRouter's
  `/api/v1/images` on ten models. Its driver read `GET /api/v1/images/models` for the ids
  and each model's `supported_parameters`, and `GET /api/v1/images/models/{id}/endpoints`
  for prices (`manga-live-tests.md:38`): the listing carries no per-image price.
- `graphToDSL` omits a prop equal to its default (`docs/reference/gen-graphs.md:373`), so
  a default of `''` means the agent-facing DSL stops showing `model` on an inherit node.

## Decision 1: the vendor is read off the model id

- `imageVendorOf(modelId): KeyVendor` in `@vn/types` beside `chatVendorFor`: an id with a
  `/` is `openrouter`, except the `@google/genai` long form `models/<id>`, which is
  `gemini`; anything else is `gemini`. OpenRouter names every model `<vendor>/<model>`, so
  the rule is exact for the ids either vendor accepts today.
- The name and the placement match Stage 1 of the four-vendors plan. That plan's table
  gains an `openrouter` row and its `imageVendorOf` returns `Vendor | undefined`; the
  `require` sites this plan touches are touched again then, which is the cost of landing
  this first. Recorded in Risks.
- `KEY_VENDORS` and `ResolvedKeys` are unchanged. The three comments saying no built-in
  backend reads the `openrouter` key are corrected at Stage 1.

## Decision 2: one routing backend, and the model id is honoured at call time

- `createImageBackend(config, keys)` returns a backend whose `modelId` is
  `config.models.image` and whose `generate`/`edit` pick a vendor per call from
  `params.modelId`. Per-vendor, per-model backends are built lazily and kept for the life
  of the routing backend. A call with an empty `modelId` is refused by name: nothing above
  the seam is allowed to send one (Decision 3 resolves it earlier).
- The Gemini backend is `createGeminiImage`, unchanged. The OpenRouter backend is new,
  `packages/providers/src/backends/openrouter.ts`,
  `createOpenRouterImage(apiKey, modelId, fetchImpl = fetch)`, and is the plugin's
  `draw.ts` moved into the providers package: same endpoint, same data-URL references,
  same `data_collection: deny`, `aspect_ratio` and `seed` when set, the first `b64_json`
  in `data` as the picture. `edit` is `generate` with the base prepended to the
  references, as the Gemini backend does it, because the endpoint has no edit form.
- The reference guard moves out of `backends/gemini.ts`'s `imagePart` into
  `packages/providers/src/image.ts` as `refGuard(img)`, and both backends call it. This is
  the four-vendors plan's Decision 7 extraction, done here because a second backend is
  what it was waiting for. Without it a testkit placeholder reaches OpenRouter and is
  billed.
- Errors are shaped for the classifier that exists. A 429 or 5xx raises
  `RetryableProviderError`, with `retryAfterMs` from a `retry-after` header when one is
  sent, so `callWithRetry` retries it. Any other non-200 raises a `ProviderError` carrying
  a numeric `status` property and a message opening with the code, `401 OpenRouter: …`, so
  `isTransient` reads the property and `faultKind` reads the head of the message. The body
  is quoted to 400 characters after the code. A missing picture and a non-JSON body are
  plain `ProviderError`s, as they were in the plugin.
- The call is captured with `captureRequest('openrouter-image', body)` where the body's
  `input_references` are replaced by `"<n> references, <bytes> bytes"`. A 400 from the
  endpoint names a field, not a byte of a picture, so the ring keeps what a reader can use
  and one page's references do not evict a conversation.
- A call whose vendor has no key raises the `ConfigError` `resolveKeys` raises for that
  vendor, made by the same function, so the desktop's key-setup handling sees the fault it
  already knows. The routing backend gets the config so it can name the env var and the
  file, never a value.
- `requiredVendors(config)` in `@vn/providers` is the set a pipeline run needs:
  `imageVendorOf(config.models.image)` and `chatVendorFor` over `models.vision` and
  `models.text`. The two `buildGenDeps`, `runPreconditions`, `record.ts` and `art.ts` pass
  it as `require`, so a project on `openai/gpt-image-2` with no Gemini key is refused
  before it pays for a picture it cannot review, and a Gemini key is no longer demanded of
  a project that draws through OpenRouter but reviews with Claude. `record.ts` builds
  `createImageBackend` rather than `createGeminiImage`, so its recordings route the same
  way. A node naming the other vendor is refused at the node, since `require` cannot see
  inside a graph.
- Seeds: OpenRouter's listing says per model whether `seed` is a supported parameter. The
  backend refuses a seeded request to a model whose catalog entry (Decision 6) lacks it,
  by name, for the reason the four-vendors plan gives at Decision 7: the seed is in the
  hash, and a dropped seed fakes reproducibility. A model with no catalog entry is sent
  the seed, and the provider's refusal, if any, is quoted.
- Consequence: a `GenImage` whose `model` names a model other than the project's now draws
  with that model. That is what the prop always claimed to do.
- `ImageResult.modelId` is what drew, as before. OpenRouter's `usage.cost` is discarded
  here. The ledger plan owns dollars and `ImageResult` has no field for one; the plugin
  recorded it in the run journal and nothing read it.

## Decision 3: an empty node model means the project's, and the run hash knows which

- `GenImage.model` and `GenEditImage.model` default to `''`.
- `GenServices.image` gains `defaultModel: string`, the project's `models.image`, set by
  `createGenServices` from the config it is built with. `imageParamsOf` resolves
  `String(props.model) || services.image.defaultModel` before the call, so no backend and
  no cache ever sees an empty id, and `CachedImageBackend`'s key holds the real model.
- The resolved model must be in the node's run hash, or the journal returns the old
  picture: changing `models.image` re-keys every task, the new task runs the graph with
  the same seeded prompt and refs, and every node's hash is unchanged, so
  `executeGenGraph` skips the image node and hands the old bytes and the old `modelId` to
  an asset keyed to the new model. So `hashOf` in `executeGenGraph`, and `graphHashes`
  under it, take a `defaults: { imageModel }` option and hash an image node's empty
  `model` as that value. `runBoundGraph` and the desktop's `gengraph.run` pass
  `config.models.image`. The authored hash (`graphDrift`) does not take it: the file did
  not change, and the task's own re-key is what carries the change.
- The estimate needs the resolved id too. `GenEstimateContext` gains `imageModel`, both
  nodes' estimates say `String(props.model) || ctx.imageModel`, and the field threads
  through `GenEstimateOptions`, `GraphsReportOptions` and the desktop's direct
  `estimateGraph` call. A caller that passes nothing gets `''` and an unpriced line, which
  is the existing behaviour for an unknown model.
- No migration. `typeVersion` is in the hash, so a bump would send every bound slot in
  every existing project back to `pending`, approved art included, and the next run would
  redraw it all at cost. A node written before this plan keeps its literal
  `gemini-2.5-flash-image` and, under Decision 2, now draws with it; on a project whose
  `models.image` is something else, that is a change of picture for that node. The
  gen-graphs reference says so, and the Project editor's picker tooltip says a node that
  names a model overrides this setting.
- `graphToDSL` omits the default, so an inherit node shows no `model` in the DSL. The
  agent-facing node description says "empty, or omitted, draws with the project's image
  model".

## Decision 4: the OpenRouter plugin is retired

- With Decision 2 the `OpenRouterImage` node is `GenImage` with a `vendor/model` id in its
  `model` prop, and the plugin's `draw.ts` is the new backend. `plugins/openrouter/` is
  deleted rather than kept as a second way to do the same call, because two code paths to
  one endpoint drift.
- Its sockets and props have the same names as `GenImage`'s, so `migrateGraphJSON` gains a
  `RETIRED_TYPES` map, `{ OpenRouterImage: 'GenImage' }`, applied before the per-type
  migrations. A graph that used the plugin loads as the built-in node with the same model
  and draws through the same endpoint; nothing is rewritten on disk until the graph is
  next saved. An installed copy under `<user>/plugins/openrouter` keeps registering a type
  no graph names any more, which is harmless; the gen-graphs reference tells the author to
  `plugin.remove` it.
- `openrouterplugin.test.ts` goes with the plugin; the retired-type migration gets its own
  test. The three comments naming the plugin and `docs/guides/api-keys.md` are corrected
  in the same commit, not two stages later.
- `plugins/gemini/` stays as the plugin system's example and its price agent.
- Reversal cost: `git revert` of one commit restores the plugin and the test; graphs the
  alias migrated back to `OpenRouterImage` need the plugin installed again, which the
  revert restores for the repo copy only.

## Decision 5: `project.setImageModel`, spliced like the art style

- `withConfigKey` learns the nested key `models.image`: inside an existing `models:` block
  the `  image:` line is replaced or, if absent, inserted as the block's first line; with
  no `models:` block, `models:\n  image: <id>\n` is inserted after `title:` as the
  top-level splice does. Every other byte of the file is untouched. `setConfigKey`'s
  re-parse check reads the value back through a path rather than a key.
- The command is `confirm: true` and `undoable: true` with `affects: ['project.yaml']`.
  Its `check` refuses an empty id, refuses an id whose vendor has no key ("no OpenRouter
  key is set; provide one in Setup first"), refuses the value the file already holds, and
  otherwise counts image tasks exactly as `previewArtStyle` does: "Set the image model to
  `openai/gpt-image-2`. It is in every image task's hash, so it re-keys N image task(s)."
- The Project editor's `models.image` row becomes a `container.menu` dropdown, one row per
  catalog entry with the row's tooltip from Decision 6, opened with `autoSearchMode: true`
  through the argument-object form, and each row drawn through `act()` with an Offer that
  runs `project.setImageModel` for that id, the way `header.ts`'s `modelMenu` records the
  text model. Picking a row runs the command at once, with the command's own confirmation;
  it is not folded into the art-style Apply, so one control runs one command and the
  `applyStyleAction` Offer is unchanged. After the command answers, the editor refetches
  `project.info`.
- The authoring agent gets no tool for this. Changing the image model is a spend decision
  the author makes once, and the agent never reads the field.

## Decision 6: the model catalog is a cached listing, refreshed on request

- `@vn/providers` gains `listOpenRouterImageModels(fetchImpl)`:
  `GET https://openrouter.ai/api/v1/images/models` for the ids and each model's
  `supported_parameters` (`aspect_ratio.values`, whether `seed` is offered), then
  `GET /api/v1/images/models/{id}/endpoints` per model for its per-image price. Both are
  parsed through zod schemas in `@vn/types` to
  `{ id, name, aspects: string[], seed: boolean, priceUsd?: number }`. The listing is the
  atomic part: no listing, no write. A model whose endpoints call fails is written without
  a price, and the command's message counts them. About fifty free calls per refresh at
  Stage 1's count.
- The catalog is written to `<user>/models.json` as `{ asOf, openrouter: [...] }` by a new
  `models.refresh` command (`mutating: true`, `affects: ['<user>/models.json']`, not
  undoable because nothing under `<user>` is in a snapshot, no `confirm` because the
  endpoints bill nothing). It is run only when the author runs it: a **Refresh models**
  button beside each picker, drawn through `act()`, whose tooltip says the catalog's date
  or that there is none. Nothing refreshes on a picker opening. A refresh that fails keeps
  the file it had and reports through the command's result. The CLI gets no command;
  `vngen` reads the same file.
- The catalog a picker draws is: `''` as "Inherit (`<models.image>`)" first (node pickers
  only), then the shipped Gemini image ids, then the cached OpenRouter ids in listing
  order, then the current value if it is in neither, so a model that dropped off the
  listing is still shown rather than silently reset. With no file, the list is the Gemini
  ids and the current value. Each OpenRouter row's tooltip carries its price, its aspect
  ratios, whether it takes a seed, and, for a non-Google model, "routed by OpenRouter; not
  zero-data-retention", from
  [`../research/openrouter-vs-direct-image-api-privacy.md`](../../research/openrouter-vs-direct-image-api-privacy.md).
- One owner in the renderer. `ProjectView` gains `imageModels: ModelCatalog` (the shipped
  ids, the cached OpenRouter rows, the default), read in main by `readModelCatalog()` in
  `@vn/pipeline` beside `readUserPrices`. The shell's project-view fetch calls
  `@vn/gengraph`'s `setModelCatalog(catalog)` every time `project.info` answers, and
  `models.refresh` and `project.setImageModel` both end by pushing the project-view reload
  the app already has, so the Gen Graph pane's `enumDef` and the Project editor read the
  same snapshot and the inherit label follows a change of `models.image`. A Gen Graph pane
  drawn before any project view has arrived lists the Gemini ids and the node's own value.
- The same file is a price table: `hostPriceTables` appends
  `{ name: 'openrouter', pricesAsOf: asOf, models }` after the plugin fragments, so the
  author's own table and the shipped one still win. `estimateSentence`'s staleness reads
  its date like any other.

## Decision 7: the routing backend is the seam, and the tests stand at it

- `createOpenRouterImage` takes `fetchImpl`, as `createGeminiImage` takes `GeminiClient`,
  so jest stands a fake endpoint up: one test per branch of the response reader (a
  picture, no picture, a non-JSON body, a 400 quoted to 400 characters after its code, a
  429 with `retry-after` retried through `callWithRetry`, a 401 that `faultKind` classes
  `auth`), one asserting the body carries `data_collection: deny`, `aspect_ratio` only
  when set, `seed` only when set and refused by name for a catalog entry without one, and
  references as data URLs, and one asserting the captured body has no base64 in it.
- The routing backend is tested with two stub backends and a `modelId` on the params: each
  vendor's stub sees its own calls, an empty id is refused, a missing key is the
  `ConfigError` with `resolveKeys`'s sentence, and a backend is built once per model.
  `requiredVendors` is tested over a config that draws on OpenRouter and reviews on Gemini
  and Claude.
- `refGuard`'s existing placeholder test in `providers.test.ts` becomes a loop over both
  backends.
- The run hash: a graph with an inherit node hashes differently under two
  `defaults.imageModel` values and the same under one; a journal record written under the
  old model is not reused under the new one; a node with a literal model is unaffected by
  the default.
- `withConfigKey('models.image')`: a file with a `models:` block and an `image:` line, one
  with the block and no line, one with no block, one already saying the value (returns
  false), and a comment beside the line that survives.
- The retired-type migration: an `OpenRouterImage` node loads as `GenImage` with its props
  and links intact.
- `readModelCatalog` and `models.refresh` under `$VNAUTHOR_HOME`: a missing file, a file
  with a bad shape (refused by name, treated as absent), a refresh that writes, a refresh
  whose listing fails leaving the file alone, a refresh where one endpoints call fails
  writing that model unpriced. `affects.test.ts` gains both commands.
- The estimate: a node with `''` prices as the context's model; with an id, as that id;
  the OpenRouter table prices an OpenRouter id and does not shadow the author's table.
- `pnpm gen:uxmodel` after the Project editor and the new commands; the anchor sweep after
  the editor change.

## Live check

Under the standing rule: `templates/basic` only, `vngen cost` before, spend recorded
after, keys through `resolveKeys` and never printed.

- `models.image: openai/gpt-image-2` on a copy of `templates/basic`, `vngen run` through
  the P3 gate (portraits and plates: six calls), then one shot. The check is that the
  assets' `modelId` says `openai/gpt-image-2`, the sizes match the aspect, and the run
  refused before drawing when the OpenRouter key was withheld. About $0.60.
- One graph with a `GenImage` on `''` and one on `google/gemini-2.5-flash-image`, bound to
  the same slot in turn: the first draws direct, the second through OpenRouter, the run
  journal names each, the desktop's run confirmation prices both from the OpenRouter
  table, and changing `models.image` between two runs of the first redraws it rather than
  resuming.
- `models.refresh` against the live listing: the count of image models, that every id has
  a slash, how many carry a price after the endpoints pass, and how long the refresh took.
- Results go to `docs/research/manga-live-tests.md` as a short "Image model default"
  section, since it is the same models and the same driver family.

## Staging

Each stage is one commit, green under `pnpm check`, `pnpm test` and `pnpm lint`, on a
branch landed with `--ff-only`.

1. **The backend and the router.** `imageVendorOf`; `refGuard` extracted;
   `backends/openrouter.ts` with its error shapes; the routing `createImageBackend`;
   `requiredVendors` at the five `require` sites; `record.ts` on the router; the three
   comments. The seed refusal waits for the catalog (Stage 5) and is sent until then.
2. **Inherit.** `GenServices.image.defaultModel`, `imageParamsOf` resolving it, the
   run-hash `defaults`, `GenEstimateContext.imageModel` threaded through the three option
   types, both nodes defaulting to `''`. `docs/reference/gen-graphs.md` node table and DSL
   note.
3. **The plugin retired.** `RETIRED_TYPES` in `migrateGraphJSON`; `plugins/openrouter/`
   and its test deleted; gen-graphs.md, api-keys.md and the manga plan's As-shipped
   updated.
4. **The setting.** `withConfigKey` nested key, `setImageModel`, `project.setImageModel`,
   the Project editor's dropdown (Gemini ids and the current value until Stage 5),
   `gen:uxmodel`, the anchor sweep, command docs regenerated.
5. **The catalog.** The two listing schemas and the fetch, `<user>/models.json`,
   `models.refresh` and its button, `readModelCatalog`, `setModelCatalog` and the
   shell-owned push, `ProjectView.imageModels`, both pickers drawing it, the seed refusal,
   the OpenRouter price table. Docs: `docs/reference/desktopAppState.md` gains the file;
   `docs/reference/pipeline-contracts.md`'s provider-seams bullet says a model id picks
   the vendor; `affects.ts`'s "four commands write there" count.
6. **The live check**, results and decisions into the research doc and As-shipped.

## Risks and open questions

- OpenRouter's `/api/v1/images` is the endpoint the Stage 1 and 2 checks used; if it
  changes shape, the backend's reader is the one place to fix, and the fake endpoint tests
  pin the shape that worked.
- The listing endpoint's authentication is unverified. If it needs a key, `models.refresh`
  requires the `openrouter` key and says so, and a project with none keeps the shipped
  list.
- OpenRouter's images endpoint documents no per-model reference cap, and Stage 2 sent
  references to every model without a refusal of the field. `gpt-image-2` direct caps at
  four (four-vendors plan, Decision 7); whether OpenRouter enforces the same is in Needs
  verification. A refusal is quoted; nothing is truncated.
- A model that OpenRouter lists but that refuses references or content (Stage 1 saw
  Recraft refuse ratios, Stage 2 saw Flux refuse content) is not filtered from the
  catalog. The refusal quotes OpenRouter and the author picks another.
- `imageVendorOf`'s slash rule is a placeholder for the four-vendors plan's table. A
  direct OpenAI id there has no slash and stays `gemini` until that plan lands; nothing in
  this plan configures one. That plan's table needs an `openrouter` row, and its
  `undefined` contract touches the five `require` sites again.
- A project that commits `models.image: openai/…` and the manifests drawn with it cannot
  be reverted to Gemini without re-keying the library again; that is the same cost as any
  change of image model and is what `confirm: true` is for.

## Needs verification before implementation

- That `GET /api/v1/images/models` answers without a key, and that
  `/api/v1/images/models/{id}/endpoints` states a per-image price for image models the way
  Stage 1's driver read it.
- Whether OpenRouter enforces a reference count per model on `/api/v1/images`.
- That the `retry-after` header reaches the backend on a 429 through `fetch` (it is a
  plain response header; nothing strips it).

## Review

Pressure-tested on 2026-09-15 by a fresh-context reviewer. Each finding and what it
changed:

1. Inherit and the journal: an unhashed default model let a re-keyed task resume the old
   picture. **Fixed**: Decision 3 hashes the resolved model in place of `''`.
2. The `typeVersion` bump would redraw every bound slot at cost. **Fixed**: no migration;
   Decision 3 records what a literal-default node now means.
3. "OpenRouter answered 429" lands in neither the retry nor the classifier. **Fixed**:
   Decision 2 raises `RetryableProviderError` for 429/5xx and a status-bearing
   `ProviderError` with the code first otherwise.
4. A missing key as `ProviderError` would class `unknown`. **Fixed**: the `ConfigError`
   `resolveKeys` makes.
5. Five `require` sites, and `record.ts` builds Gemini directly. **Fixed** in the facts,
   Decision 2 and Stage 1.
6. Dropping `gemini` from `require` removes the reviewers' only pre-run key check.
   **Fixed**: `requiredVendors` is the union over image, vision and text.
7. `vngen cost` prices no unbound task. **Fixed**: the claim is now about the graph
   estimate; the live check no longer asserts task pricing.
8. The listing carries no price; Stage 1 read `/endpoints`. **Fixed**: Decision 6 fetches
   endpoints per model on refresh and decides the partial-failure case.
9. Seeds sent to a model without a seed parameter, and the reference cap. **Fixed**: the
   catalog records `seed` and the backend refuses by name; the cap is in Risks and Needs
   verification.
10. The plugin API does have `customPropUX`. **Fixed**: the false fact is gone; Decision 4
    rests on the two-code-paths argument.
11. Loose ends of retiring the plugin: the test, installed copies, three comments, the key
    guide two stages late. **Fixed**: a `RETIRED_TYPES` alias migration so old graphs
    load, the test deleted at Stage 3, the comments and the guide at Stages 1 and 3.
12. The Project editor has no datapath for `listenum`, and one Apply would run two
    confirmed commands. **Fixed**: a `container.menu` dropdown with per-row Offers that
    run `project.setImageModel` on pick; the art-style Apply is unchanged.
13. A refresh row inside a dropdown is a value, not a control, and a refresh on open is a
    mutating command fired by a UI open. **Fixed**: a button drawn through `act()`; no
    refresh on open.
14. Two writers of `setModelCatalog` with different snapshots; a stale inherit label.
    **Fixed**: the shell owns it from every `project.info` answer, and the two commands
    push the project-view reload.
15. `imageModel` must thread through `reportGraphs` and the desktop's direct call; the DSL
    omits a default. **Fixed** in Decision 3.
16. `CachedImageBackend` would key on `''`. **Fixed**: the runtime resolves the id before
    any backend or cache sees it.
17. `setImageModel('')` and the `models/` id form. **Fixed**: `check` refuses empty;
    `imageVendorOf` treats `models/` as Gemini.
18. Absorption by the four-vendors plan touches the `require` sites again. **Recorded** in
    Decision 1 and Risks; landing this first is still the choice, because that plan has no
    date and this one has a motivating result.

## As shipped

Stage 1 (the backend and the router), and what differed from the plan:

- `imageVendorOf` returns an `ImageVendor` (`'gemini' | 'openrouter'`, declared beside it
  in `packages/types/src/textmodels.ts`) rather than `KeyVendor`: `@vn/types` sits below
  `@vn/config`, where `KeyVendor` lives, and cannot import it. Every `ImageVendor` is a
  `KeyVendor`, so the `require` sites and the router index `ResolvedKeys` with it
  unchanged.
- The `ConfigError` a missing key raises is built by one function, `missingKeyError` in
  `packages/config/src/keys.ts`, which `resolveKeys` now calls and the router calls for a
  vendor first needed mid-run, so the two cannot drift.
- `createOpenRouterImage(apiKey, modelId, opts)` takes an options object (`fetchImpl`)
  rather than a positional `fetchImpl`, so Stage 5's seed flag joins it without a second
  positional argument.
- `createImageBackend(config, keys, opts)` takes a `build` option, the per-vendor backend
  constructor, which is the seam Decision 7's router test stands two stub backends at; the
  default builds the real Gemini and OpenRouter backends.
- `packages/testkit/src/record.ts` passes `[imageVendorOf(config.models.image)]` as
  `require`, not `requiredVendors(config)`: a recording mocks text and vision (the file
  header says why), so requiring the vendors of models it never calls would refuse a
  recording that only needs the image key. The other four sites pass `requiredVendors`.
- `docs/guides/api-keys.md`'s two sentences about who reads the OpenRouter key were
  reworded at Stage 1 in terms that hold before and after the plugin is retired, rather
  than once now and again at Stage 3.

Stage 2 (inherit), and what differed from the plan:

- `executeGenGraph` takes no `defaults` option. It reads the model to hash off
  `ctx.services.image.defaultModel`, the same field the runtime resolves an empty prop to,
  so the value hashed and the value drawn with cannot disagree. `graphHashes` and
  `nodeHash` take the `defaults: { imageModel }` argument the plan names, and
  `invalidateGenGraph` takes it as an optional fourth argument so the `force` path records
  the same hash; the desktop's `invalidateBound` leaves it out, because an `invalidated`
  record is never resumed from. `runBoundGraph` and the desktop's `gengraph.run` therefore
  pass nothing: their services already carry the model.
- Which prop inherits is declared on the spec rather than by type name: `GenNodeSpec`
  gains `imageModelProp`, both image nodes name `model`, and `registerGenNode` refuses a
  name that is no prop, in the same probe as `slotProp`. A plugin type can declare it too.
- `createGenServices` takes `imageModel: string` in its deps rather than the config,
  because `GenServicesDeps` carries no config and `imageBackend.modelId` is the mock's id
  under `--mock`, not the project's. The four hosts that build services (the desktop's two
  sites, the CLI's `graphRuntime` call and the testkit project) pass
  `config.models.image`.
- `GenEstimateContext.imageModel` is optional rather than `''` when absent, so the three
  plugin tests that build a context by hand keep compiling; the node estimates read
  `ctx.imageModel ?? ''`, which prices as the unknown model the plan describes.
- The node pickers gain an "Inherit (project image model)" row at Stage 2 rather than
  Stage 5, because a `listenum` over a value its rows do not hold shows nothing. Stage 5
  replaces the label with the model's id. Checked at Stage 4 in the running app: the
  node's `DropBox` carries the row (`'Inherit (project image model)': ''`) in its enum,
  and `DropBox.setValue` in `vendor/path.ux/scripts/menu/dropbox.ts` looks an empty string
  up through `prop.keys`, where `''` is a key like any other, so the row's label is what
  an empty model shows. No sample graph holds an empty model, so the label was read off
  the widget's definition rather than seen drawn.

Stage 3 (the plugin retired), and what differed from the plan:

- `RETIRED_TYPES` rewrites the node's `_structName` (`graph.OpenRouterImage` to
  `graph.GenImage`) in `migrateNode`, before that node's per-type renames, and inside a
  group instance's subgraph too. The file's `typeVersion` is kept, since the alias holds
  only at the version whose keys the two types share; a later `GenImage` rename would then
  replay over the aliased node as over any other. The load reports it as its own note, "N
  OpenRouterImage node(s) now load as GenImage", rather than as an "updated to vN" line.
- The plugin's `cost` output (the spend OpenRouter reports per call) is not carried into
  the built-in backend; nothing read it. The manga plan's As-shipped says so.
- One sentence in `docs/research/manga-live-tests.md` advised drawing lettered pages
  "through the OpenRouter plugin"; it now says through OpenRouter by model id. The rest of
  that document is the record of a check that ran through the plugin and is left as
  history.

Stage 4 (the setting), and what differed from the plan:

- `withConfigKey` did not learn a nested key. It and `setConfigKey` are written over
  `ConfigTextKey`, a top-level key whose re-parse check indexes `parsed.data[key]`, and a
  nested key would have meant a second shape for every caller. `withImageModel(text, id)`
  and `setImageModel(dir, id)` sit beside them in `packages/config/src/config.ts` and do
  what Decision 5 says: replace the `image:` line inside the `models:` block at its own
  indent, insert it as the block's first line when absent, or insert `models:\n  image:`
  after `title:` when the file has no block. `setImageModel` re-parses and refuses (a
  `ConfigError` saying to set it by hand) when the value does not read back, which is also
  where a `models: {}` flow scalar lands, since a spliced row under it is not YAML.
- The command's `check` reads the vendor's key through `keyStatus` (resolved or not, never
  a value) with the project's secrets directories, so the refusal wording is Decision 5's
  and no key value passes through the session.
- The picker's rows are not each drawn through `act()`. A path.ux `MenuTemplate` row is a
  label, a callback and a tooltip, with no node for an Offer to be applied to, so the
  `DropBox` is recorded once through `act()` with an Offer for `project.setImageModel`
  that supplies `model`, the way `header.ts`'s `modelMenu` records the text model; the
  sweep therefore lists the command with `supplies: ['model']` rather than one anchor per
  id. The `DropBox` is built with `UIBase.constructElement('rowframe-x')` inside the
  editor's raw `rows` div, since the Project editor draws raw DOM and has no `Container`
  to call `menu` on; the sweep's widget walk reaches it (nothing under `unwalked`).
- `imageModelRows(current)` and `imageModelAction` live in `rules/projectbar.ts`, where
  `ux-model.json` derives them, so the four project-bar situations carry an `imageModel`.
- `affects.test.ts` skips `project.setImageModel` by name: its harness runs each writer
  once against a fixture project, and this one is refused until the model's vendor has a
  key, which the harness may not leave behind. `session.test.ts` covers the write with a
  throwaway key and the refusal with the env var cleared.
- The anchor sweep was run against `examples/mySampleRepo` (79 of 173 commands anchored,
  up from 78) and `anchors.json` is committed with the run. The two `notify.*` records it
  re-keyed follow the sample project's newest notification, not this change.
- `docs/reference/desktop-app-editors-misc.md`'s Project section said one field was
  editable; it now says two and describes the dropdown. `docs/reference/module-map.md`'s
  `config.ts` row names `setImageModel`.

Stage 5 (the catalog), and what differed from the plan:

- Two of the "Needs verification" items were settled by reading the two endpoints without
  a key on 2026-09-15. `GET /api/v1/images/models` answers without one (52 models) and so
  does each `/endpoints`. The endpoints record states a per-picture price only for models
  billed per picture (`billable: output_image, unit: image`; 26 of the 52, Recraft,
  Seedream, Qwen, xAI, Sourceful); OpenAI's, Google's and Microsoft's are billed per
  output token and Black Forest Labs' per megapixel, and those are written without
  `priceUsd` rather than priced from a guessed token count. `perImagePrice` takes the row
  with no `variant` as the base tier, or the cheapest tier where every row names one. So
  the graph estimate still says "no price for `openai/gpt-image-2`" after a refresh, and
  the claim in "What this adds" holds for the per-picture models only. The listing also
  declares `input_references.max` per model (1 to 16), which answers the reference-cap
  question in Risks; it is not carried into the catalog, and a refusal is still quoted
  rather than pre-empted.
- `readModelCatalog`, `writeModelCatalog` and `catalogPriceTable` live in
  `packages/gengraph/src/modelstore.ts` under `@vn/gengraph/state`, beside
  `pricestore.ts`, which is where `readUserPrices` is; the plan placed the read in
  `@vn/pipeline`, which only hosts `hostPriceTables`. `@vn/pipeline` re-exports
  `readModelCatalog` from `graphload.ts` so the CLI, which does not depend on the graph
  package directly, reads the listing for its router through the package it already has.
- The fetch is `listOpenRouterImageModels(fetchImpl)` in
  `packages/providers/src/backends/openrouterlist.ts`, and the schemas are
  `packages/types/src/imagemodels.ts`. The listing's `supported_parameters` is read for
  `aspect_ratio.values` and the presence of `seed` and otherwise passed through, so a new
  parameter cannot fail the parse.
- The seed refusal is `createOpenRouterImage`'s `seed: false` option, and the router takes
  a `catalog` option (`id` and `seed` per entry) that its default builder reads it from;
  `createProviders` passes the same option through. Both hosts' `buildGenDeps` (the
  desktop's and the CLI's) read the cached listing and pass it, so a task with an authored
  seed is refused by name at the seam for a model the listing says takes none.
- The pickers' rows are one function, `imageModelChoices` in
  `packages/gengraph/src/modelcatalog.ts`, which the Project editor reaches through
  `imageModelRows` in `rules/projectbar.ts` and the node pickers through an `EnumProperty`
  built per resolution with the row's label as its ui name and its tooltip as its
  description, so a `<vendor>/<model>` id is drawn as written rather than title-cased. The
  node picker adds the node's own value by reading it off the row's data path when the
  rows are resolved. A Google model reached through OpenRouter carries "routed by
  OpenRouter" without the zero-data-retention clause, as Decision 6 says.
- path.ux's `DropBox` kept the first `EnumProperty` it resolved for its button label
  (`this.prop`, set once in `_updateFromPath`), while the menu it opens resolved the rows
  afresh, so a node frame built before the first project view arrived said "Inherit
  (project image model)" on its button until rebuilt. Fixed in path.ux `2977e4dc`, which
  makes the cache follow each resolution; the gitlink bump is in the Stage 6 commit.
- The shell's read is `refreshProjectView` in `renderer/pathux/app/bridge.ts`: it runs
  `project.info` through `command:exec` directly (so a refusal with no project open is not
  said out loud), hands `imageModels` to `setModelCatalog`, and tells `onProjectView`
  watchers. It runs with every `refreshWorkspace` (which a `project.yaml` write reaches
  through `documents:wrote`) and after a successful `models.refresh` by id, since that
  command writes nothing in the workspace. The Project editor no longer reads
  `project.info` itself: its reload asks the bridge, and it paints what every watcher is
  told, so the read has one owner. `ProjectView.imageModels` is a `ModelCatalog` of the
  shipped ids, the cached OpenRouter rows, the project's model and the listing's date.
- `models.refresh` (`apps/desktop/src/main/commands/models.ts`, a new `models` namespace)
  has no `check` beyond naming the file it writes; its message counts the models listed,
  those with a per-picture price, and any endpoints calls that failed. `affects.test.ts`
  skips it, as it skips `plugin.prices`, because it reaches the network; the write is
  covered in `session.test.ts` with a fake fetch, including the failing listing that
  leaves the file alone. The plan said the harness gains both commands.
- Refresh models is drawn on the Project editor inside the picker's row frame and on the
  Gen Graph pane's bar (`refreshModelsAction` in `rules/models.ts`, shared by both rule
  modules), refused with no project open since the command runs in a workspace session.
  The Gen Graph pane records it in its own `models` pass and re-records it from every
  project view, so the date in its tooltip follows a refresh.
- `hostPriceTables` appends the listing's table after the plugin fragments, as the plan
  says, by passing it in `genPriceTables`'s `plugins` list rather than adding a fourth
  parameter.
- The anchor sweep was re-run (80 of 174 commands anchored); both Refresh models buttons
  are anchored. `models.refresh` was also run once in the live app against the real
  endpoints, which wrote 52 models to this machine's `<user>/models.json` and redrew both
  pickers with 53 and 54 rows.
- `docs/reference/pipeline-contracts.md`'s provider-seams bullet, `desktopAppState.md`'s
  persistence table, `gen-graphs.md`'s image-node bullets, the Project section of
  `desktop-app-editors-misc.md` and four `module-map.md` rows were updated.

Stage 6 (the live check), and what differed from the plan:

- Results are in
  [`../research/manga-live-tests.md`](../../research/manga-live-tests.md#image-model-default--openrouter-as-a-backend-2026-09-15).
  Every asset of a `templates/basic` copy on `openai/gpt-image-2` came back from that
  model at the exact 16:9, the model sheets through the edit path included; 13 of 13 shots
  were accepted first try; the withheld key was refused with `resolveKeys`'s sentence
  before any spend; the same slot drew through OpenRouter on an empty node model and
  direct through Gemini on a literal one, with the drift reported by `vngen status` in
  between; the inherit node's `draw` hash differs per project model while the nodes above
  it do not; the listing came back in 2.7 s over 53 free calls.
- The post-gate wave was run whole rather than stopping after one shot, because the model
  sheets are the only exercise of the edit path. About
  $1.80 in all against the plan's
  $0.60: $0.98 on OpenRouter for 28 pictures, the rest
  reviews, one direct Gemini draw and two decompositions.
- Two observations left for later work: `vngen cost` counts a drifted bound slot as 0 to
  draw, so a redraw the next run will make is not in the graph estimate; and a graph node
  whose `aspect` prop is empty draws at the provider's default size, not the project's.
- Switching a node's model away and back redrew rather than resumed, because
  `executeGenGraph` resumes from a node's latest journal record only. That is the
  pre-existing rule and it over-draws rather than under-draws, so it is recorded, not
  changed.
- path.ux's `DropBox` label cache (Stage 5's known limit) was fixed in path.ux `2977e4dc`
  and the gitlink bumped in this stage's commit.
