# In-app update checks

Status: **shipped**. Plan 4 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).
Depends on [`packaging-the-desktop-app.md`](packaging-the-desktop-app.md) for the version source
of truth, and on [`release-ci-workflow.md`](release-ci-workflow.md) for something to check
against.

An installed copy should find out that a newer one exists. Nothing here publishes to an app
store, and nothing here installs anything without being asked.

## Two stages, and the first one is the one to build

**Stage 1 — check only.** Read the GitHub releases feed, compare semver, tell the author, open
the release page in their browser if they want it. Roughly forty lines, no new dependency, and
it works **unsigned, on every platform**.

**Stage 2 — download and install.** `electron-updater`, later.

The reason for the split is not caution, it is that stage 2 does not work yet where it matters
most. `electron-updater` on macOS requires a signed app — Squirrel.Mac refuses an unsigned
bundle and fails **silently**, which is the worst failure mode available. On Windows/NSIS it
works fine unsigned, but SmartScreen still greets each downloaded update. Until
[`../code-signing-and-notarization.md`](../code-signing-and-notarization.md) is done, stage 2 is a
better experience on exactly one platform, and stage 1 is the same experience on all of them.

So: build stage 1 now. Add stage 2 in the same command, behind the same entry point, when
signing lands — the author-facing act does not change, only what happens after they say yes.

## `app.checkForUpdates`

A registered command, because everything the app does is. A new `apps/desktop/src/main/commands/
app.ts` for the namespace — `app.*` is where shell-level acts that are not about a workspace
belong, and there will be more of them.

```
app.checkForUpdates(quiet=false)
```

- `quiet` — a periodic check passes `true` and says nothing when there is no update. The manual
  one says "you are up to date", because silence in answer to a button is indistinguishable
  from a broken button.
- Not mutating, so no `check`. It writes nothing and touches no workspace.
- Reachable from **Help ▸ Check for Updates…**, the palette, CDP and the agent, for free, by
  being a command.

What it does:

1. `GET https://api.github.com/repos/<ISSUE_REPO>/releases/latest`, unauthenticated, with a
   timeout and a `User-Agent`.
2. Compare `tag_name` (minus `v`) against the running version — `apps/desktop/package.json`'s,
   per plan 2 — with a small semver compare written here rather than a dependency, since the
   only shapes we ever produce are `x.y.z`.
3. Report through the ordinary `report(outcome)` hook, so the result lands in
   `vngen/state/notifications.jsonl` like everything else and survives the frame being dismissed.

**The repo constant is the one from `report.agent`.** `ISSUE_REPO` is already fixed at build
time and deliberately not read from the git remote, for exactly the reason that applies here
too: a packaged app has no checkout, and a fork's releases are not the ones this build should
offer. Reuse it; do not add a second constant that can disagree.

### Failure is quiet by design

No network, GitHub down, rate-limited (60/hr unauthenticated, per IP, which is generous for a
desktop app and *not* generous for CI — do not put this in a test that hits the network):

- Manual check: says it could not reach the release list. Names the reason, offers the releases
  URL as a fallback.
- Periodic check: says nothing at all. An app that pops a network error at someone who was
  writing a scene has made their day worse for no benefit.

A **prerelease** tag is ignored. `releases/latest` already excludes them, which is one more
reason to use that endpoint rather than listing releases and taking the first.

## What the author sees

A notification, not a modal. Existing machinery, one frame in the menu bar, already durable:

> **v0.4.0 is available** — you have v0.3.1. [Release notes] [Download]

Both buttons open the browser via `shell.openExternal` at the release page. In stage 2 the
second becomes **Install**, and the notification gains a progress state.

Nothing is downloaded before the author clicks, at either stage.

## The periodic check

- **Off by default.** A first-run app that phones home before being asked is a bad first
  impression, and this one has no telemetry story to point at.
- A setting, once there is a settings system — and per
  [`onboarding-editor-and-user-level-keys.md`](onboarding-editor-and-user-level-keys.md) that
  system will write to `userConfigDir()`, so the preference is per user rather than per project.
  Correct: whether you want update notices is not a fact about a story.
- When on: once on launch, then daily, always `quiet=true`.

## As shipped

Stage 1, as scoped. Two commands, one pure module with its tests, and one Help menu entry — the
plan's "roughly forty lines" was about right for the deciding half. What it did not anticipate is
that a notification could not point anywhere except a pane.

- **`apps/desktop/src/main/updates.ts` is the half that decides, and it never fetches.**
  `checkAgainst(running, payload)` takes the parsed body; `session.checkForUpdates()` is the
  request. That split is the usual one (`keyaudit.ts` does the same) and here has a second reason
  written into both files: GitHub allows 60 unauthenticated requests an hour **per IP**, and a CI
  runner shares one with every other job on it, so a test that reached the real endpoint would
  spend the budget the app itself depends on. Nothing in `tests/updates.test.ts` touches a network.

- **A notification names an act, never an address — which is why `NotificationLink` grew a
  `command` field.** The plan drew two buttons on the notification frame, and there is no such
  thing: a link was `{editor, subject}`, the argument shape of `view.open`, and every row in the
  list is already one button running `notify.follow`. So the row *is* the affordance, and what it
  needed was somewhere other than a pane to point. It could not point at a URL: `app.openKeyLink`
  states the rule — naming a *field* rather than an address is why no part of this app can ask the
  OS to open one it was handed — and a notification, being a line of a tracked file git
  union-merges across clones, is exactly the input that rule exists for. `app.openReleases`
  therefore derives its own address from `ISSUE_REPO`, and the link names it.

- **The link is narrowed against an allow-list, not against the registry.** `linkCommand` accepts
  only what `LINK_COMMANDS` lists — today one entry — for the same reason `linkTarget` narrows an
  editor against `EDITOR_IDS`, with a sharper edge: an unknown editor is a pane that does not
  exist, but an unknown *command* is an act nobody intended, and a line arriving from somebody
  else's branch could otherwise ask a click to start a paid `pipeline.run` or empty the log.
  `notify.follow` dispatches over a `switch` whose `never` fall-through makes adding an entry
  without teaching it to follow one a compile error.

- **The two buttons were always one page.** GitHub's `releases/latest` is both the notes and the
  installers, so "Release notes" and "Download" had a single destination all along.

- **Nothing here throws, and that is the `quiet` contract rather than politeness.** A command that
  threw would be filed as an `error` by `shouldFileCommand` whatever `quiet` said — which is
  precisely the notification the plan wants a background check not to post. So a failed check comes
  back as an `unreachable` verdict carrying its own sentence, and `announcementFor` decides
  separately whether it is worth saying: an available update always, a failure only when a person
  asked, and "you are up to date" never. That last one is not silence about a manual check — the
  command's own message says it on screen through `report` — it is a refusal to put a durable line
  in the log every time the answer is no news.

- **`ahead` is a fourth verdict.** Anyone running from a checkout between releases is ahead of the
  latest tag, and telling them they are up to date when they are carrying unreleased code is a
  small lie that makes the whole check harder to trust. A dev build is otherwise compared like any
  other: `runningVersion` takes the version out of `describeVersion`'s `0.1.0 (dev abc1234)`,
  because "is there something newer than this" has the same answer either way.

- **The periodic check is not built, only its argument.** `quiet` exists and behaves; nothing calls
  it. The plan made the setting conditional on a settings system, and the honest state today is
  that the app makes no request until the author picks the menu entry — which is what the command's
  own description and the Help menu's tooltip both say, so nobody has to read this file to find out
  whether the app phones home.

**Owed.** The one thing no amount of local work can stand in for: this repository has no published
release, so `releases/latest` answers 404 and every run of this today takes the `unreachable`
path. That path *was* exercised against the real endpoint — status 404, rate limit intact, the
`User-Agent` accepted — which proves the request, but the `available` verdict, the notification it
posts, and the click that opens the page are argued for by unit tests over the payload shape
rather than by having happened. They become checkable the moment plan 3b's first tag is pushed,
and that is one line on the tasklist rather than two.

## Acceptance

- `app.checkForUpdates` from the palette against a repo whose latest release is newer produces
  the notification, and Download opens the right page.
- Against an equal version it says so; with `quiet=true` it says nothing.
- With the network unplugged, the manual check reports a reachable failure and the periodic one
  is silent.
- A prerelease tag newer than the running version is not offered.
- The version compared is the packaged app's, not `0.0.0`.
