# In-app update checks

Status: **planned**. Plan 4 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).
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
[`code-signing-and-notarization.md`](code-signing-and-notarization.md) is done, stage 2 is a
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

## Acceptance

- `app.checkForUpdates` from the palette against a repo whose latest release is newer produces
  the notification, and Download opens the right page.
- Against an equal version it says so; with `quiet=true` it says nothing.
- With the network unplugged, the manual check reports a reachable failure and the periodic one
  is silent.
- A prerelease tag newer than the running version is not offered.
- The version compared is the packaged app's, not `0.0.0`.
