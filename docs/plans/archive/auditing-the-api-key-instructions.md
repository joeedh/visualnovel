# Auditing the API-key instructions

Status: **shipped**. Plan 5 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).
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

## As shipped

Both tiers exist. The split between them held; what the plan did not anticipate is that a status
code is not always evidence.

- **Tier 1 is `scripts/check-key-links.mjs`** (`pnpm check:keylinks`), run by a `links` job in
  `ci.yml`. It reads the file through `parseKeyGuide` — the same reader the Setup pane uses, so
  the checker and the pane cannot disagree about what a vendor block says — and requests every URL
  in `guideUrls`, three attempts with a backoff. The verdict for one response is `linkVerdict`,
  and it is pure and tested: non-2xx fails, and a redirect fails if it leaves the *site* (last two
  labels of the host, so `platform.claude.com` → `accounts.google.com` fails while
  `aistudio.google.com` → `accounts.google.com` does not) or lands a deep link on the site root.
  Query strings are ignored, because `ai.google.dev` adds `?hl=th` on its own.

- **A 200 is not proof, so every URL is asked about twice.** `aistudio.google.com` is a
  single-page app behind a sign-in: *every* path under it answers 200 from Google's login,
  including one that has never existed. The first draft of this check passed a deliberately broken
  `https://aistudio.google.com/apikey-moved-last-year` — which is to say it would have gone on
  reporting the Gemini key console as fine for exactly as long as Google keeps the domain. So each
  URL is now sent alongside `canaryFor(url)`, a sibling path that cannot exist, and `linkReport`
  returns one of three states. A host that answers the canary too yields **`unverified`**: the run
  says the host is up and nothing more, and does not fail. Today that is one of our six links, and
  the closing summary states the count every run — the number going up is the signal that this
  check is quietly ceasing to be one.

- **`unverified` is deliberately not a failure.** Whether a vendor puts its console behind a
  sign-in is not a fact about our file, and a check that failed on it would be one people switch
  off. It is the same reasoning as tier 2's `could-not-check`, arrived at from the other end.

- **The `links` job is separate from `check`, and takes no submodules.** It is the one gate here
  that can go red because of somebody else's outage, so it should read as its own tick rather than
  as "the tests broke" — and since nothing it touches is compiled through the renderer, it is also
  the one job that runs whatever state `vendor/path.ux` is in.

- **Tier 2 is `scripts/audit-key-instructions.mjs`** (`pnpm audit:keydocs`) over
  `apps/desktop/src/main/keyaudit.ts`, on a Monday cron in `.github/workflows/key-docs-audit.yml`.
  Everything that decides anything is in the `.ts` and has tests; the `.mjs` is the network, the
  key and the file. It writes `key-instructions-review.md`, uploads it every week drift or not,
  and on drift files **one** issue found by title and edited in place.

- **It exits 0 in every path there is** — no key, a page that will not load, a model that will not
  answer, a reply about the wrong vendor. Each of those becomes a `could-not-check` line naming
  what happened, because a red weekly cron nobody is on the hook for is a cron people mute.

- **A run that checked nothing may not report a pass.** The first version of `renderReview` opened
  a keyless run with "**Nothing to do.** All 2 vendor sections still match" — a clean bill of
  health for a week in which no page was read. The headline now counts what was actually
  compared, and a run with no agreements at all says **"Nothing was checked"** in its first
  sentence. That line is the whole report for anyone reading a notification.

- **The audit authenticates through the variable its own documentation names.** The key is read
  from `vendor.env` in the guide's yaml block rather than from a constant here, so if that line
  ever goes stale the audit stops working and says which variable it wanted. It names the
  variable; it never names a value.

- **`--dry-run` does everything except the call.** It fetches, converts and assembles the prompt,
  then reports its size — which is how you check the audit is still reading the pages you think it
  is without spending anything, and how the fetch half of this was verified with no key on hand.

- **`htmlToText` is deliberately not a parser.** What is being compared is a walkthrough, and
  every wording of "open this, click that" survives losing the markup; both vendor pages are
  framework-rendered anyway. It keeps list items on separate lines, because step order is most of
  what the audit is checking. `pageProblem` refuses anything under 2000 characters as a loading
  shell rather than letting a model report drift against nothing.

**Owed.** Tier 2's model round-trip has never run: there is no key on this machine, so the
acceptance lines about a stale copy reporting `drifted` with a pasteable proposal, and about the
issue it opens, are argued for by unit tests over the reply shape and by a `--dry-run` that stops
one step short. Running it once by hand with a real key is the remaining item on the tasklist.

## Acceptance

- Breaking a URL in `docs/api-keys.md` fails `ci.yml`, naming the vendor and the URL.
- Tier 2 run by hand against unmodified docs reports agree for both vendors and opens no issue.
- Tier 2 against a deliberately stale copy reports drifted, and its proposed edit is one a
  person could apply as-is.
- A vendor page that cannot be fetched yields `could-not-check`, and the run still succeeds.
- Nothing in either tier writes to `docs/api-keys.md`.
