# Code signing and notarization

Status: **deferred by decision**, not by oversight. Listed as plan 6 of
[`archive/INDEX.md#shipping-the-app-tasklist`](archive/INDEX.md#shipping-the-app-tasklist) and deliberately not scheduled.

This page exists so the decision is written down rather than rediscovered the first time
somebody reports a scary warning.

## What unsigned actually costs

**Windows.** SmartScreen shows "Windows protected your PC — unrecognized app" on the installer.
It is dismissible: More info → Run anyway. Two extra clicks and one moment of doubt. A
technical user shrugs; a non-technical user may well stop. The warning fades as a signed
certificate accrues reputation, which means it does not fade at all while unsigned.

**macOS.** Materially worse, and the reason mac is not in the first release. Gatekeeper
quarantines a downloaded unsigned app and the ordinary path to open it is not "click through a
warning", it is a terminal command. And per
[`archive/INDEX.md#in-app-update-checks`](archive/INDEX.md#in-app-update-checks), auto-update on mac requires signing
outright — Squirrel.Mac refuses an unsigned bundle and fails **silently**.

**Linux.** Nothing. AppImage has no equivalent gate.

So the honest summary: unsigned Windows is a papercut, unsigned mac is a wall.

## What it costs to fix

| | Price | Effort |
| --- | --- | --- |
| **Azure Trusted Signing** (Windows) | ~$10/month | Moderate — cloud signing, no cert on disk, electron-builder supports it. Requires a verifiable org or 3+ years of individual trading history |
| **OV cert from a CA** (Windows) | ~$200–400/year | Hardware token, painful in CI. Do not |
| **Apple Developer Program** (macOS) | $99/year | Signing plus notarization; electron-builder does both with an app-specific password. Well-trodden |

## When to do it

Three triggers, any of which is enough:

- **macOS becomes a target.** It is not optional there, so this plan lands with that one.
- **Someone outside the immediate circle installs it.** The SmartScreen warning is a papercut
  among people who trust the sender and a real barrier among people who do not.
- **Stage 2 of the update plan.** Auto-install of a build the OS distrusts, on top of an app
  the OS already distrusted, is not a thing to ship.

Until one of those, Windows-unsigned with a plain sentence on the download page — "Windows will
warn you; choose More info → Run anyway" — is the proportionate answer. Saying it up front costs
one line and removes most of the doubt the warning creates.

## What lands when it does

- Repo secrets for the signing credentials, and the matrix legs in
  [`archive/INDEX.md#release-ci-workflow`](archive/INDEX.md#release-ci-workflow) gaining a signing step.
- `macos-latest` in that matrix, with notarization, which adds real wall-clock to a release —
  Apple's service takes minutes, sometimes longer.
- `electron-updater`'s mac path becomes viable, so stage 2 of
  [`archive/INDEX.md#in-app-update-checks`](archive/INDEX.md#in-app-update-checks) becomes worth building.
- A note wherever the download lives that the warning is gone, because the old sentence telling
  people to expect one is then itself a reason to distrust the download.
