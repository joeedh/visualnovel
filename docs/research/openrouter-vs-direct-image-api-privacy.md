# Data privacy: OpenRouter versus direct calls to image-generation APIs

<!-- toc -->

- [Why this matters for this project](#why-this-matters-for-this-project)
- [The structural difference](#the-structural-difference)
- [OpenRouter's own posture](#openrouters-own-posture)
    - [ZDR-only routing and image models, concretely](#zdr-only-routing-and-image-models-concretely)
- [Direct providers](#direct-providers)
    - [Google — Gemini API and Vertex AI](#google--gemini-api-and-vertex-ai)
    - [OpenAI — gpt-image family](#openai--gpt-image-family)
    - [Black Forest Labs — Flux, and its hosts](#black-forest-labs--flux-and-its-hosts)
- [Side-by-side](#side-by-side)
- [What this means for vngen](#what-this-means-for-vngen)
- [Unverified items](#unverified-items)
- [Primary sources](#primary-sources)

<!-- tocstop -->

Researched 2026-08-24 from the providers' own published terms, docs, and policy pages.
Every claim below carries its source; anything that could not be verified on a first-party
page is flagged inline and collected at the end. Policies change, so the day-counts and
toggle names here reflect only what those pages said on 2026-08-24.

## Why this matters for this project

`vngen` sends an author's creative material over the wire: prompts derived from the
screenplay and character bibles, plus reference images (portraits, plates, model sheets,
uploaded concept art) for image-to-image calls. The `edit` path uploads a base image every
time. The only live image backend today is Gemini's image model (`createGeminiImage`,
"nano banana"), called directly with the author's own key; the provider seam means
switching to a different backend takes only a `project.yaml` change. Each routing choice
differs in what an author's unpublished fiction and artwork are exposed to: who stores it,
for how long, who may read it, and whether anyone may train on it.

## The structural difference

A direct API call involves one company and one contract. Routing through OpenRouter adds a
second company in the data path and (for models with multiple hosts) can fan a single
model id out across several downstream providers, each with its own retention and training
policy. Three consequences follow:

1.  1. **Two policies apply to every request instead of one.** OpenRouter applies its own
       logging posture first, and the downstream provider applies a second one. The weaker
       of the two policies is the one that holds in practice.
2.  2. **The downstream provider is chosen by a price-prioritizing load balancer** rather
       than by you, unless you pin it. OpenRouter states that routing does not consider
       retention policy by default; routing filters only when you set the account toggles
       or per-request parameters
       ([privacy-and-logging](https://openrouter.ai/docs/features/privacy-and-logging)).
3.  3. **OpenRouter relays its downstream providers' guarantees rather than auditing
       them.** Its ZDR classification derives from provider policies, and OpenRouter
       conservatively assumes retention where a policy is unclear. Nothing in the docs
       describes verification of actual provider behavior
       ([ZDR guide](https://openrouter.ai/docs/guides/features/zdr)).

None of this makes OpenRouter unusable for private material (its defaults are better than
several direct providers') but it changes the analysis from "read one policy" to "read one
policy plus the policy of every provider the router may pick."

## OpenRouter's own posture

- **No prompt/completion logging by default.** "We do zero logging of your
  prompts/completions, even if an error occurs, unless you opt-in"
  ([FAQ](https://openrouter.ai/docs/faq)). OpenRouter describes itself as having a ZDR
  policy for its own storage
  ([ZDR guide](https://openrouter.ai/docs/guides/features/zdr)).
- Request metadata is logged (timestamps, model, token counts). No retention window is
  published (unverified gap).
- **Opt-in logging gives a 1% discount in exchange for a broader license.** Enabling the
  logging discount grants OpenRouter a broader license over that content, including
  commercial uses and anonymized distribution per its Terms
  ([terms](https://openrouter.ai/terms); exact clause wording not captured verbatim).
  Leave the setting off for unpublished fiction.
- **Provider-training toggles.** Account settings gate routing to providers that may train
  on inputs (separately for paid and free models) and to free endpoints that may publish
  prompts. Most free models train on prompts or may publish them, so disabling those
  toggles 404s most free endpoints. The toggles' default states are not documented
  (unverified).
- **Per-request controls are the real mitigation:** `provider.only` / `provider.order` /
  `allow_fallbacks: false` pin hosts, `data_collection: "deny"` excludes data-collecting
  providers (the default is `"allow"`), and `zdr: true` restricts routing to the ZDR
  endpoint list
  ([provider-routing](https://openrouter.ai/docs/features/provider-routing)).
- **Images get a weaker clause than text.** The privacy policy says media is "not
  persist[ed] … beyond the duration necessary to route the request, except as required for
  abuse detection, security, billing, or legal compliance". The text-prompt zero-logging
  claim carries no such carve-outs. Nothing reconciles whether a base64 image returned as
  output counts as a zero-logged "completion" or falls under this media clause
  ([privacy policy](https://openrouter.ai/privacy)).
- **BYOK does not take OpenRouter out of the path.** With your own provider key, requests
  still transit OpenRouter's routing (OpenRouter holds the encrypted key and makes the
  call), the same logging posture applies, and OpenRouter charges 5% of list cost past a
  monthly free allowance. In return, the downstream provider sees the request under your
  account's terms, and your data policies still filter which BYOK endpoints are eligible
  ([BYOK docs](https://openrouter.ai/docs/guides/overview/auth/byok)).
- **Jurisdiction/compliance:** OpenRouter, Inc. is based in New York and runs its servers
  in the US or otherwise outside the EEA/UK. Its trust center lists SOC 2 Type 2. A
  mutually signed DPA is available only on the enterprise tier; self-serve accounts can
  read it, but it does not apply to them ([terms](https://openrouter.ai/terms),
  [trust center](https://trust.openrouter.ai/),
  [support article](https://openrouter.zendesk.com/hc/en-us/articles/47828437697051)).
  Enterprise adds in-region routing (`eu.openrouter.ai` / `us.openrouter.ai`).

### ZDR-only routing and image models, concretely

The list below is parsed from the live list at
[`/api/v1/endpoints/zdr`](https://openrouter.ai/api/v1/endpoints/zdr) (764 endpoints, 48
providers, 2026-08-24):

- **Gemini image models qualify.** Exactly two providers serve
  `google/gemini-2.5-flash-image` and the newer Nano Banana line (Google AI Studio and
  Vertex), and both are on the ZDR list. The "many unknown third-party hosts" concern does
  not apply to this model.
- **`openai/gpt-image-*` and every Flux endpoint are absent** from the ZDR list. A
  ZDR-only account cannot reach them through OpenRouter at all. A non-ZDR account reaches
  them under whatever the serving host retains.

## Direct providers

### Google — Gemini API and Vertex AI

Terms are per-API, not per-model; the same rules cover the whole Nano Banana family (2.5
Flash Image through the Gemini 3.x image models).

- **Free tier trains on your content.** On the unpaid Gemini API tier, Google "uses the
  content you submit … and any generated responses to provide, improve, and develop Google
  products and services," and human reviewers "may read, annotate, and process your API
  input and output." Google advises against submitting sensitive or confidential material.
  EEA/UK/Switzerland users get paid-tier terms even on the free tier
  ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). This is the largest
  privacy difference in this comparison, and it is a Google-side term, so it applies
  identically whether the free tier is reached directly or through OpenRouter.
- The paid tier does not train on prompts and outputs, but it logs them for abuse
  monitoring for 55 days, and authorized Google employees review classifier-flagged
  content ([usage policies](https://ai.google.dev/gemini-api/docs/usage-policies)).
- ZDR is now available on the Gemini Developer API by request. It clears content and
  identifiable metadata from abuse logs, with carve-outs for Search grounding's 30-day
  storage that cannot be disabled, Live API session state, and explicit context caches
  ([ZDR doc](https://ai.google.dev/gemini-api/docs/zdr)).
- **Vertex AI is the stronger surface:** it offers contractual no-training (Service
  Specific Terms §17 "Training Restriction"), a default 24-hour cache that you can disable
  at the project level, a ZDR path, CMEK, VPC Service Controls, and data residency.
  Abuse-monitoring prompt logging applies only to non-invoiced accounts. Current excerpts
  give the retention figure as both 30 and 90 days, so the figure is unresolved; verify it
  on the live page
  ([data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance)).
- **Every generated image carries a SynthID invisible watermark, non-optionally**
  ([image generation doc](https://ai.google.dev/gemini-api/docs/image-generation)). This
  is not a data leak. It is a provenance fact: published VN art is machine-identifiable as
  Gemini output.

### OpenAI — gpt-image family

DALL·E was removed from the API in May 2026; the current models are gpt-image-2 / 1.5 / 1
/ 1-mini.

- API data is not used for training by default (policy since March 2023), and inputs and
  outputs, including abuse logs, are retained for 30 days
  ([data controls](https://developers.openai.com/api/docs/guides/your-data)).
- `/v1/images/generations` and `/v1/images/edits` are ZDR-eligible, and that covers
  uploaded base images. ZDR is granted through a sales request rather than self-serve.
  Under ZDR, OpenAI states content is not logged and not human-reviewed.
- Under the intermediate "Modified Abuse Monitoring" arrangement, image and file inputs
  are the one carve-out that may still be logged "in rare cases". This matters for a
  pipeline that uploads reference art on every edit call.
- Safety Retention: classifier-flagged content may be retained and human-reviewed on
  certain models.
- DPA, SOC 2 Type 2, US processing by default with regional processing (US, Europe, UAE)
  and storage-only residency elsewhere; image endpoints are residency-eligible. (The
  openai.com policy pages refused automated fetching, so this is corroborated via search
  excerpts — flagged.)

### Black Forest Labs — Flux, and its hosts

- **BFL's own API trains on your inputs and outputs by default.** Opting out requires an
  email to legal@/privacy@blackforestlabs.ai, and the license survives for content already
  used in training. Retention is "as long as reasonably necessary", and no day count
  appears anywhere. The 10-minute delivery-URL expiry is the validity window of a signed
  link, not a deletion guarantee. Contract law is Delaware law with arbitration, despite
  the German parent; the privacy policy sets out the GDPR terms (SCCs, BFL GmbH as EEA
  controller). The enterprise offering advertises ZDR and on-prem
  ([ToS](https://bfl.ai/legal/terms-of-service),
  [privacy](https://bfl.ai/legal/privacy-policy),
  [enterprise](https://bfl.ai/enterprise)). For unpublished creative work, these defaults
  are the worst of the major providers surveyed.
- **Replicate:** API-created predictions (inputs, outputs, files, logs) auto-delete after
  one hour by default, and web-playground predictions are kept indefinitely until manually
  deleted. No clause grants training rights over raw customer content
  ([retention doc](https://replicate.com/docs/topics/predictions/data-retention)). This is
  the best default retention policy of any hosted option here.
- **Together AI:** training is opt-in only, and a self-serve settings toggle enables true
  ZDR (content "not stored, retained, or used for model training," which also means
  Together cannot later retrieve or delete it for you). Together does not offer geographic
  pinning ([privacy](https://www.together.ai/privacy)).
- **fal.ai:** fal.ai is widely described as not training on customer data, but that
  promise could not be found on any fal-owned page. The public terms only license
  anonymized/aggregated "Usage Data." Media expiry is configurable per request via a
  lifecycle header, and the platform default is unstated. Verify the claim against their
  DPA before relying on it (flagged unverified).
- **Stability AI:** May use inputs and outputs for training by default. Users can opt out
  themselves on the account page
  ([opt-out article](https://kb.stability.ai/knowledge-base/opt-out-of-data-training-for-platform-api)).
- **Self-hosting requires no third party.** FLUX.1 [schnell] is Apache 2.0. FLUX.1 [dev]
  outputs are freely usable commercially, but running the model itself in a
  revenue-generating or end-user-facing product requires BFL's paid license
  ([non-commercial license](https://bfl.ai/legal/non-commercial-license-terms)). The
  hosted providers bundle that paid license.

## Side-by-side

| Surface               | Trains on inputs?                   | Default retention                                                              | ZDR path                                            | Human review                          | Notes                                                                                     |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| OpenRouter (itself)   | No                                  | Prompts: none by default; metadata: unstated                                   | Own posture is ZDR; downstream via ZDR-only routing | —                                     | Adds downstream provider's policy on top; images carry an exceptions clause text does not |
| Gemini API, free tier | **Yes** (exc. EEA/UK/CH)            | Used for product improvement; 55-day abuse logs                                | No                                                  | Yes, incl. product-improvement review | Never send private material here                                                          |
| Gemini API, paid tier | No                                  | 55-day abuse logs                                                              | By request (new)                                    | Flagged content only                  | Current `vngen` backend; SynthID on every image                                           |
| Vertex AI             | No (contractual)                    | 24 h cache; abuse logs 30 or 90 days (conflicting), non-invoiced accounts only | Yes (cache off + exception form)                    | Flagged content only                  | CMEK, residency, VPC-SC                                                                   |
| OpenAI gpt-image      | No                                  | 30 days                                                                        | Yes — image endpoints eligible, via sales           | Flagged content only                  | Image inputs loggable "in rare cases" under modified monitoring                           |
| BFL Flux API          | **Yes, by default** (email opt-out) | "As long as reasonably necessary"                                              | Enterprise only                                     | Unstated                              | Weakest default posture surveyed                                                          |
| Replicate (API)       | No training clause found            | **1 hour**, automatic                                                          | Effectively, via the 1-hour deletion                | Unstated                              | Web playground retains indefinitely                                                       |
| Together AI           | Opt-in only                         | Unstated day count                                                             | Self-serve toggle                                   | Unstated                              | ZDR forfeits later deletion/export requests                                               |
| fal.ai                | **Unverified** on first-party pages | Configurable per request; default unstated                                     | Enterprise claim, unverified                        | Unstated                              | Confirm via DPA before trusting                                                           |
| Self-hosted Flux      | No one                              | Local only                                                                     | N/A                                                 | No one                                | [dev] needs a commercial license to serve end users                                       |

## What this means for vngen

1.  1. The current setup (direct Gemini image calls on the author's own key) is a
       reasonable default, provided the key is on the paid tier. The free tier trains on
       prompts and outputs and has humans review them, so a VN author's unpublished
       screenplay and character art must not be sent on a free-tier key. The guide
       docs/guides/api-keys.md should state this in a sentence, since the pipeline cannot
       tell which tier a key is on.
2.  2. **OpenRouter adds an intermediary without adding capability for the current
       backend.** Gemini image models on OpenRouter route only to Google's own two
       endpoints. The privacy cost is that OpenRouter keeps a metadata log with unbounded,
       unstated retention, that its terms carry media-clause exceptions, and that a second
       company sits in the path. The gain is one bill across providers and easy model
       switching. If OpenRouter support is ever added for that convenience, ship it with
       `data_collection: "deny"`, the logging discount off, and either pinned providers or
       `zdr: true`. ZDR-only routing forecloses gpt-image and Flux entirely.
3.  3. **If a Flux backend is added, the choice of host determines the privacy outcome.**
       BFL's own API trains by default with an email-only opt-out; Replicate's one-hour
       auto-deletion and Together's opt-in-plus-ZDR-toggle are materially better defaults,
       and self-hosting [schnell] is the only route that involves no third party.
4.  4. **Take the most care with reference-image uploads.** The `edit` path sends author
       artwork, not just derived prompt text. OpenAI's policy is the only one that singles
       out image inputs as still loggable under its reduced-monitoring arrangement;
       OpenRouter's media clause lists exceptions its text clause does not; BFL's training
       default covers uploaded content explicitly.
5.  5. **Provenance is mandatory on the current backend.** Every Gemini image carries
       SynthID. Authors publishing a VN to the web (the Pages pipeline) should know their
       art is machine-identifiable as AI-generated. OpenAI attaches C2PA metadata
       (unverified for current models), and stripping a file's metadata removes that C2PA
       record while leaving SynthID in place.

## Unverified items

The research passes collected these. Each is safe to treat as "unknown" rather than as
either answer.

- These questions remain open for OpenRouter: the metadata retention window; the default
  states and exact labels of the five privacy toggles; whether image outputs count as
  "completions" (zero-logged) or fall under the media clause; the verbatim license wording
  for opt-in logging; whether any audit of downstream ZDR behavior exists; and the full
  subprocessor list.
- Google: Vertex abuse-log retention (30 vs 90 days in concurrent excerpts); Gemini-API
  ZDR eligibility criteria; per-model security-controls matrix.
- OpenAI's enterprise-privacy and DPA pages refused automated fetching, and the claims
  were corroborated from excerpts. The same treatment covers the current C2PA behavior on
  gpt-image-2.
- fal.ai limits its no-training claim to third-party models, and retains media by default.
- BFL: the concrete retention period is unknown, as is whether enterprise contracts add a
  no-training term (BFL's public policy excludes enterprise content from its scope).

## Primary sources

OpenRouter: [FAQ](https://openrouter.ai/docs/faq) ·
[privacy & logging](https://openrouter.ai/docs/features/privacy-and-logging) ·
[ZDR](https://openrouter.ai/docs/guides/features/zdr) ·
[ZDR endpoint list](https://openrouter.ai/api/v1/endpoints/zdr) ·
[provider routing](https://openrouter.ai/docs/features/provider-routing) ·
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok) ·
[privacy policy](https://openrouter.ai/privacy) · [terms](https://openrouter.ai/terms) ·
[trust center](https://trust.openrouter.ai/)

Google: [Gemini API terms](https://ai.google.dev/gemini-api/terms) ·
[usage policies](https://ai.google.dev/gemini-api/docs/usage-policies) ·
[logs policy](https://ai.google.dev/gemini-api/docs/logs-policy) ·
[Gemini API ZDR](https://ai.google.dev/gemini-api/docs/zdr) ·
[Vertex data governance](https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance)
· [image generation](https://ai.google.dev/gemini-api/docs/image-generation)

OpenAI: [data controls](https://developers.openai.com/api/docs/guides/your-data)

Flux and hosts: [BFL ToS](https://bfl.ai/legal/terms-of-service) ·
[BFL privacy](https://bfl.ai/legal/privacy-policy) ·
[BFL enterprise](https://bfl.ai/enterprise) ·
[BFL non-commercial license](https://bfl.ai/legal/non-commercial-license-terms) ·
[Replicate retention](https://replicate.com/docs/topics/predictions/data-retention) ·
[Replicate terms](https://replicate.com/terms) ·
[Together privacy](https://www.together.ai/privacy) · [fal terms](https://fal.ai/terms) ·
[fal privacy](https://fal.ai/privacy) ·
[Stability opt-out](https://kb.stability.ai/knowledge-base/opt-out-of-data-training-for-platform-api)
