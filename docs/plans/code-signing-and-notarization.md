# Code signing and notarization

This plan is deferred by decision rather than by oversight. It is listed as plan 6 of
[`archive/INDEX.md#shipping-the-app-tasklist`](archive/INDEX.md#shipping-the-app-tasklist)
and is deliberately not scheduled.

This page records the decision so that nobody has to rediscover it the first time somebody
reports an alarming warning.

## What unsigned actually costs

**Windows.** SmartScreen shows "Windows protected your PC — unrecognized app" on the
installer. The user can dismiss it through More info → Run anyway, which costs two extra
clicks and one moment of doubt. A technical user shrugs; a non-technical user may well
stop. The warning fades as a signed certificate accrues reputation, so the warning never
fades while the installer is unsigned.

**macOS.** Support is materially worse, which is why mac is not in the first release.
Gatekeeper quarantines a downloaded unsigned app, and the ordinary way to open it is a
terminal command rather than a click through a warning. Per
[`archive/INDEX.md#in-app-update-checks`](archive/INDEX.md#in-app-update-checks),
auto-update on mac requires signing outright: Squirrel.Mac refuses an unsigned bundle and
fails silently.

**Linux.** No signing step. AppImage has no equivalent gate.

In summary, an unsigned Windows build only inconveniences the user, while an unsigned
macOS build blocks them.

## What it costs to fix

|                                     | Price          | Effort                                                                                                                                       |
| ----------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Azure Trusted Signing** (Windows) | ~$10/month     | Moderate — cloud signing, no cert on disk, electron-builder supports it. Requires a verifiable org or 3+ years of individual trading history |
| **OV cert from a CA** (Windows)     | ~$200–400/year | Hardware token, painful in CI. Do not                                                                                                        |
| **Apple Developer Program** (macOS) | $99/year       | Signing plus notarization; electron-builder does both with an app-specific password. Well-trodden                                            |

## When to do it

Each of the three triggers below is enough on its own:

- **macOS becomes a target.** It is not optional on macOS, so this plan lands together
  with that target.
- **Someone outside the immediate circle installs it.** People who trust the sender treat
  the SmartScreen warning as a papercut; people who do not treat it as a real barrier.
- **Stage 2 of the update plan.** Auto-installing a build the OS distrusts onto an app the
  OS already distrusted must not ship.

Until one of those happens, shipping unsigned on Windows with a plain sentence on the
download page ("Windows will warn you; choose More info → Run anyway") is proportionate.
Saying it up front costs one line and removes most of the doubt the warning creates.

## What lands when it does

- Repo secrets hold the signing credentials, and the matrix legs in
  [`archive/INDEX.md#release-ci-workflow`](archive/INDEX.md#release-ci-workflow) gain a
  signing step.
- `macos-latest` in that matrix requires notarization, which adds wall-clock time to a
  release. Apple's service takes minutes and sometimes longer.
- The mac path in `electron-updater` becomes viable, so stage 2 of
  [`archive/INDEX.md#in-app-update-checks`](archive/INDEX.md#in-app-update-checks) becomes
  worth building.
- Say wherever the download is hosted that the warning is gone, because the old sentence
  telling people to expect one then becomes a reason to distrust the download.
