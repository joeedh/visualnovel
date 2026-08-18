# Auditing the API-key instructions

Status: **planned**. Plan 5 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).
Needs `docs/api-keys.md`, which
[`onboarding-editor-and-user-level-keys.md`](onboarding-editor-and-user-level-keys.md) writes.

The Setup pane walks an author through creating a Gemini key and a Claude key. Both vendors
reword and rearrange those pages without telling anyone. Instructions that were right when
shipped and are wrong a year later are worse than none, because they are confidently wrong at
the exact moment a new user has nothing else to go on.

## One source, and it has to be machine-readable

`docs/api-keys.md` is the only copy of the walkthrough: the Setup pane renders it, the docs site
serves it, and anything printable is generated from it. That is a rule from plan 1; this plan is
what makes it pay.

For the audit to say anything precise, the file needs structure the checker can find without
parsing prose. Per vendor:

- An H2 whose slug is the vendor id (`## gemini`, `## anthropic`), so the pane and the checker
  find sections by the same key `KEY_VENDORS` already orders.
- A **fenced yaml block** holding the facts a machine should check — the console URL, the docs
  URL, the env var name, whether a free tier exists.
- The steps as an ordinary numbered list beneath it.

The yaml block is what makes tier 1 exist at all. Grepping URLs out of prose finds the ones in
examples too, and then the link check reports on things nobody has to maintain.

## Tier 1 — the link check. Deterministic, blocking, in CI

Every URL in those yaml blocks gets an HTTP request. Non-2xx, or a redirect that lands on a
different host, fails the job.

- **This is the failure that actually happens.** A vendor moving its key console is what breaks
  a new user; the words around the link surviving is secondary.
- No LLM, no key, no cost, no flake beyond ordinary network noise — so retry twice before
  failing, and fail on the third.
- Runs in `ci.yml`, blocking, because it is cheap and its verdict is unambiguous.

## Tier 2 — the semantic audit. Advisory, weekly, never blocking

An agent fetches each vendor's current key documentation and compares it against our steps,
emitting proposed revisions.

**It cannot gate a release, and the reason is worth stating.** A model comparing prose to prose
across pages that get reworded constantly will produce false positives on a good fraction of
runs. A blocking check that cries wolf is one people learn to override, and an overridden check
is worse than an absent one — it costs the same and buys nothing. So:

- **It runs on a weekly cron, not on a tag.** You want to hear the docs moved *before* you are
  mid-release. A release blocked behind a network-dependent model call is a release that stalls
  for reasons unrelated to the code.
- Output is `key-instructions-review.md`: for each vendor, agree / drifted / could-not-check,
  and where it says drifted, the current wording beside ours and a proposed edit.
- On any drift it **opens an issue** with that file as the body, one per run, updating the open
  one rather than filing a second. An artifact nobody is told about is an artifact nobody reads.
- `could-not-check` is a first-class verdict. A page behind JS rendering or a bot wall is a
  thing the audit could not read, and saying "agree" about it would be a lie.

It needs a model key as a repo secret and costs a few cents a week. Weekly is affordable;
per-PR is not, and per-PR would also mean every contributor's branch making vendor requests.

## What it must never do

**Never edit `docs/api-keys.md` itself.** It proposes; a person applies. The file is what a new
user reads when they are most confused and least able to tell that something is wrong — an
unreviewed model edit landing there is the highest-consequence automated write in the repo, for
the smallest saving.

## Acceptance

- Breaking a URL in `docs/api-keys.md` fails `ci.yml`, naming the vendor and the URL.
- Tier 2 run by hand against unmodified docs reports agree for both vendors and opens no issue.
- Tier 2 against a deliberately stale copy reports drifted, and its proposed edit is one a
  person could apply as-is.
- A vendor page that cannot be fetched yields `could-not-check`, and the run still succeeds.
- Nothing in either tier writes to `docs/api-keys.md`.
