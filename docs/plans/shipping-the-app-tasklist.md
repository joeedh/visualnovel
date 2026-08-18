# Shipping the app — tasklist

Status: **planned**

Everything between "the app runs from a checkout" and "someone who is not us has it installed and
updating." Five plans. This page is the running order and the checkbox list; each plan states its
own decisions and acceptance criteria and is the authority on its own work.

The shape of the problem: a packaged app has no checkout, no `pnpm`, no submodule, and no
`keys/` directory sitting in a repo the author happens to be standing in. Each of those is a plan.

| #   | Plan                                                                                                   | Covers                                                                        |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1   | [`onboarding-editor-and-user-level-keys.md`](onboarding-editor-and-user-level-keys.md)                   | keys above the project, the Setup pane, `offered: false` and path.ux's filter  |
| 2   | [`packaging-the-desktop-app.md`](packaging-the-desktop-app.md)                                           | electron-builder, what ships, the version source of truth, the runtime doctor  |
| 3   | [`release-ci-workflow.md`](release-ci-workflow.md)                                                       | tag-triggered GitHub Actions, the green gate, the draft release               |
| 4   | [`in-app-update-checks.md`](in-app-update-checks.md)                                                     | `app.checkForUpdates` as a command, the releases feed, later auto-install      |
| 5   | [`auditing-the-api-key-instructions.md`](auditing-the-api-key-instructions.md)                           | `docs/api-keys.md` as one source, the link check, the weekly advisory audit    |
| —   | [`code-signing-and-notarization.md`](code-signing-and-notarization.md)                                   | deferred by decision: what it costs, what it unblocks, when to do it           |

## Order

Three edges are real:

- **1 before 2.** Packaging has to know where user state lives, because that is the one directory
  the installer must not put inside the install and the uninstaller must not delete by accident.
  `userConfigDir()` is plan 1's function.
- **2 before 3.** CI runs the packaging command. There is nothing to automate until it works by
  hand on one machine.
- **2 before 4.** An update check compares against the app's version, and plan 2 is where a single
  version source of truth is decided.

Plan 5 is independent of all of them — it only needs `docs/api-keys.md`, which plan 1 writes — and
plan 6 is deliberately not scheduled.

```
wave A   1 onboarding + user keys
wave B   2 packaging                 5 key-docs audit
wave C   3 release CI                4 update checks
```

## The list

### 1 — Onboarding editor and user-level keys

- [ ] path.ux: `setAreaMenuFilter` + `makeAreasEnum(filter?)`, tests, submodule commit
- [ ] `@vn/config`: `userConfigDir` / `userKeysDir`, `secretDirsFor` opt-out, testkit + jest guards
- [ ] `project.setKey` scope prop; `project.keyStatus`
- [ ] `offered?: false` in `EDITORS`, the shell's filter install, the View submenu narrowing
- [ ] `docs/api-keys.md`, then the onboarding editor rendering it
- [ ] The File menu entry, and the first-run notification
- [ ] Docs, including the three `CLAUDE.md` additions

### 2 — Packaging the desktop app

- [ ] Decide and record the version source of truth; stop shipping `0.0.0`
- [ ] electron-builder config: `files`, `asarUnpack`, `extraResources` for `docs/api-keys.md`
- [ ] A hoisted install for packaging, so pnpm's symlinks do not reach the app image
- [ ] The runtime doctor: `git` on PATH, and what the app says when it is not
- [ ] `pnpm package` produces an installer on Windows that a clean machine can run

### 3 — Release CI workflow

- [ ] `.github/workflows/release.yml`, tag-triggered, `submodules: recursive`
- [ ] The green gate: `pnpm check`, `pnpm test`, `pnpm lint` before anything is built
- [ ] Assert the tag matches the version rather than writing the version
- [ ] Upload artifacts to a **draft** release; publishing stays a human act

### 4 — In-app update checks

- [ ] `app.checkForUpdates` as a registered command, reachable from Help and the palette
- [ ] The releases feed read, the semver compare, and what it does when offline
- [ ] The notification, and the browser hand-off to the release page
- [ ] A periodic check, off by default until someone asks for it

### 5 — Auditing the API-key instructions

- [ ] `docs/api-keys.md` structured so a machine can find the URLs and the steps
- [ ] Tier 1: the deterministic link check, in CI, blocking
- [ ] Tier 2: the weekly advisory audit, its artifact, and the issue it opens
- [ ] The rule that tier 2 never fails a build

### 6 — Code signing and notarization

Not scheduled. The plan exists so the decision is written down rather than rediscovered when the
first user reports a SmartScreen warning.
