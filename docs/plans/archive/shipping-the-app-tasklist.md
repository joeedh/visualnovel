# Shipping the app — tasklist

Status: **shipped**. All five scheduled plans are built and in the codebase; each one's own page
records what it deviated from. What is left unticked below is not code — it is the handful of
acceptance runs that need a machine or a push this branch does not have: the public path.ux commit
that unblocks every CI job, a clean VM for the installer, a real model key for tier 2 of the audit,
and a tag, which is also what makes the update check's `available` verdict observable. They are
listed where they belong rather than collected here, because each is the last line of a plan.

Everything between "the app runs from a checkout" and "someone who is not us has it installed and
updating." Five scheduled plans and one deferred by decision. This page is the running order and
the checkbox list; each plan states its own decisions and acceptance criteria and is the authority
on its own work.

The shape of the problem: a packaged app has no checkout, no `pnpm`, no submodule, and no
`keys/` directory sitting in a repo the author happens to be standing in. Each of those is a plan.

| #   | Plan                                                                                     | Covers                                                                        |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | [`onboarding-editor-and-user-level-keys.md`](onboarding-editor-and-user-level-keys.md)     | keys above the project, the Setup pane, `offered: false` and path.ux's filter  |
| 2   | [`packaging-the-desktop-app.md`](packaging-the-desktop-app.md)                             | electron-builder, what ships, the version source of truth, the runtime doctor  |
| 3   | [`release-ci-workflow.md`](release-ci-workflow.md)                                         | `ci.yml` on every push, then the tag-triggered build and the draft release     |
| 4   | [`in-app-update-checks.md`](in-app-update-checks.md)                                       | `app.checkForUpdates` as a command, the releases feed, later auto-install      |
| 5   | [`auditing-the-api-key-instructions.md`](auditing-the-api-key-instructions.md)             | `docs/api-keys.md` as one source, the link check, the weekly advisory audit    |
| —   | [`code-signing-and-notarization.md`](../code-signing-and-notarization.md)                     | deferred by decision: what it costs, what it unblocks, when to do it           |

## Order

**Plan 3 is two workflows, and they schedule differently.** `ci.yml` — check/test/lint on every
push and PR — depends on nothing in any other plan and lands first, in wave A. `release.yml` is
the tag-triggered build, and it needs plan 2. Splitting them is what makes the rest of this order
work: plan 5's blocking half runs *in* `ci.yml`, and `master`'s every-commit-green claim gets a
machine on day one rather than at the end.

The edges that are real:

- **1 before 2.** Packaging ships `docs/api-keys.md` as `extraResources`, and plan 1 is what
  writes it. It must also know where user state lives — `userConfigDir()` is plan 1's function —
  because that is the one directory the installer must not put inside the install and the
  uninstaller must not delete by accident. **Plan 2 does not currently say this**; it is a
  checkbox below rather than a section there, and should become one.
- **`ci.yml` before 5.** Tier 1 of the audit is a job in `ci.yml`, and plan 5's first acceptance
  criterion is that breaking a URL fails it.
- **2 before `release.yml`.** CI runs the packaging command. There is nothing to automate until it
  works by hand on one machine.
- **2 and `release.yml` before 4.** An update check compares against the app's version (plan 2's
  single source of truth) and reads the releases feed — which has nothing in it until a tag has
  produced a draft release.

```
wave A   1 onboarding + user keys        3a ci.yml
wave B   2 packaging                     5 key-docs audit
wave C   3b release.yml
wave D   4 update checks
```

Plan 6 is deliberately not scheduled.

## The list

### 1 — Onboarding editor and user-level keys

- [x] path.ux: `setAreaMenuFilter` + `makeAreasEnum(filter?)`, tests, submodule commit
- [x] `@vn/config`: `userConfigDir` / `userKeysDir`, `secretDirsFor` opt-out, testkit + jest guards
- [x] `project.setKey` scope prop; `project.keyStatus`
- [x] `offered?: false` in `EDITORS`, the shell's filter install, the View submenu narrowing
- [x] `docs/api-keys.md` — **an H2 per vendor slugged to its `KEY_VENDORS` id, each with the fenced
      yaml block plan 5 checks**; then the onboarding editor rendering it
- [x] The File menu entry, and the first-run notification
- [x] Docs, including the three `CLAUDE.md` additions

### 3a — `ci.yml` (wave A, ahead of everything it guards)

- [x] `.github/workflows/ci.yml` on push and PR, `submodules: recursive`, pnpm store cache
- [x] `pnpm check && pnpm test && pnpm lint` — `pnpm check`, not a bare `tsgo`, or the renderer
      is never typechecked
- [ ] **Push `vendor/path.ux` before the first run can pass.** `submodules: recursive` fetches the
      pinned commit from `github.com/joeedh/path.ux`, and the commit plan 1 added (`25b4519a`) is
      local only — the public tip is still its parent. Every job fails at checkout until it is
      pushed, and this is not something the workflow can work around.

### 2 — Packaging the desktop app

- [x] Stop shipping `0.0.0`: bump `apps/desktop/package.json`, the decided source of truth —
      `0.1.0`, plus `version.ts` so a build between releases says `0.1.0 (dev <sha>)`
- [x] electron-builder config: `files`, `extraResources` for `docs/api-keys.md`. **No `asarUnpack`**
      — nothing native ships, and the only executable the app spawns is the machine's own `git`
- [x] A hoisted install for packaging, so pnpm's symlinks do not reach the app image
- [x] Where user state lives, in the installer and the uninstaller — `userConfigDir()` is outside
      the install and survives an uninstall (`deleteAppDataOnUninstall: false`). The session store
      moved there too: derived from `__dirname` it was inside `app.asar`, and `mkdir` on a *file*
      is why a packaged build opened no window at all
- [x] The runtime doctor: `git` on PATH, and what the app says when it is not — and, found by
      testing it, the startup path that died on `git init` before the warning could be shown
- [x] `pnpm package` produces an NSIS installer — **the clean VM is still owed**; see the plan's
      [As shipped](packaging-the-desktop-app.md#as-shipped) for what was verified instead
- [x] A smoke test that forces one lazy import of **each** SDK — "the window opened" is not evidence
      (`pnpm smoke`, against the built binary, with the vendor key variables blanked)
- [x] The image contains no `packages/`, no `vendor/`, no `dist/pathux-types/`
- [ ] Install the built `vnstudio-Setup-0.1.0.exe` on a clean VM and open a project

### 5 — Auditing the API-key instructions

- [x] Tier 1: the deterministic link check over the yaml blocks, in `ci.yml`, blocking
- [x] Tier 2: the weekly advisory audit, its artifact, and the issue it opens
- [x] The rule that tier 2 never fails a build, and that neither tier writes to `docs/api-keys.md`
- [ ] Run tier 2 end to end against a real key — locally there is none, so the model round-trip
      and the issue it files are the one part of this plan nothing has yet exercised

### 3b — `release.yml`

- [x] `.github/workflows/release.yml`, tag-triggered, `submodules: recursive`
- [x] The green gate runs once, first, and separately from the build matrix
- [x] Assert the tag matches the version rather than writing it
- [x] Upload artifacts to a **draft** release; publishing stays a human act
- [ ] Tag something and watch it run. Blocked on the same unpushed submodule as 3a — and the two
      lines nothing local can stand in for are the draft release itself and the installer that
      comes out of a Windows runner rather than this machine

### 4 — In-app update checks

- [x] `app.checkForUpdates` as a registered command, reachable from Help and the palette
- [x] The releases feed read, the semver compare, and what it does when offline — the deciding
      half is `apps/desktop/src/main/updates.ts`, so it is tested without a network; nothing in
      `tests/updates.test.ts` spends the 60-an-hour budget a CI runner shares by IP
- [x] Reuse `ISSUE_REPO` from `@vn/agentreport`; do not add a second repo constant
- [x] A prerelease newer than the running version is not offered — `releases/latest` excludes
      them, which is the reason for that endpoint
- [x] The notification, and the browser hand-off to the release page — `NotificationLink` grew a
      `command` field so a notification can name an **act** rather than an address, narrowed by an
      allow-list; `app.openReleases` derives its own URL. See the plan's
      [As shipped](in-app-update-checks.md#as-shipped)
- [x] A periodic check, off by default until someone asks for it — nobody has, so it is not built:
      `quiet` exists and behaves, and nothing calls it. The app makes no request until the author
      picks the menu entry
- [ ] Watch the `available` verdict happen: the notification it posts and the click that opens the
      page are argued for by unit tests over the payload shape rather than by having occurred.
      Blocked on 3b's first tag — `releases/latest` answers 404 today, so every real run takes the
      `unreachable` path (which *was* exercised against the live endpoint). The Help entry itself
      is also owed a live CDP check; this worktree's launcher never opened a renderer target

The repo must be public for an unauthenticated feed read; it already is
(`joeedh/visualnovel`), so this constrains nothing today — but it is why the repo cannot go
private later without hosting a feed.

### 6 — Code signing and notarization

Not scheduled. The plan exists so the decision is written down rather than rediscovered when the
first user reports a SmartScreen warning.
