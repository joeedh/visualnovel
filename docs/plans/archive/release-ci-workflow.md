# Release CI workflow

Status: **shipped**. Plan 3 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).
Depends on [`packaging-the-desktop-app.md`](packaging-the-desktop-app.md), which is what this
automates.

The repo has no `.github/workflows` at all. This adds two: a release workflow triggered by a
tag, and the ordinary per-push checks that should have existed before it.

## `ci.yml` — the checks, on every push and PR

Written first, because a release workflow that is the *only* place `pnpm test` runs is a
release workflow that discovers breakage at the worst moment.

```
on: [push, pull_request]
  checkout (submodules: recursive)
  setup-node 20 + pnpm, with a store cache
  pnpm install --frozen-lockfile
  pnpm check && pnpm test && pnpm lint
```

Two things this repo needs that a generic workflow would miss:

- **`submodules: recursive` is mandatory.** `vendor/path.ux` is a submodule and
  `apps/desktop`'s `build` runs `pnpm doctor` first, which fails by name without it. Without
  the flag, every desktop build fails identically and confusingly.
- **`pnpm check` is two passes.** The root script already chains `check:renderer`, so calling
  `pnpm check` is enough — but it must be `pnpm check`, not `tsgo -p tsconfig.json`, or
  `apps/desktop/renderer/**` is never typechecked.

This also gives `master` the property `CLAUDE.md` already claims for it — every commit green —
a machine that verifies it rather than a convention.

## `release.yml` — on a tag

```
on: push tags 'v*'

  gate         ubuntu   check / test / lint          (the same steps as ci.yml)
    │
    ├─ version  assert tag == apps/desktop/package.json version
    │
  build        matrix: windows-latest [+ macos-latest, ubuntu-latest later]
    │            pnpm build → pnpm package → upload-artifact
    │
  publish      draft GitHub Release, all artifacts + latest.yml attached
```

### The gate runs first, and separately

The build matrix does not start until check/test/lint pass once. Running them inside each matrix
leg would triple the cost to learn the same fact, and running them not at all would let a tag
produce an installer from a tree that does not typecheck.

### The version assertion

A shell step, four lines: read `.version` out of `apps/desktop/package.json`, compare with
`${GITHUB_REF_NAME#v}`, fail with both values named if they differ.

**It asserts; it never writes.** A workflow that bumps the version has to commit and push to
`master`, and `master` is linear and rebased-onto by hand — a bot pushing to it is a merge
commit waiting to happen. Bumping the version is a normal reviewed commit; the tag comes after.

### The build matrix

Windows only, at first. Adding `macos-latest` is one line in the matrix, and is worth doing the
day signing is sorted — an unsigned dmg is a support burden, not a release.

Each leg: `submodules: recursive`, install, `pnpm build`, `pnpm package` with `--publish never`,
then `upload-artifact`. Publishing from inside the matrix would race three legs writing one
release; the separate `publish` job downloads all the artifacts and makes one.

### Draft, not published

The release is created as a **draft**. Someone reads the notes, checks the installer size looks
sane, and publishes by hand. This matters more than it sounds: publishing is what makes every
installed copy's update check start offering the build, so publishing is the irreversible act
and it should be a person's.

Release notes are generated from the commits since the last tag — which reads well precisely
because the history is linear and the noise commits were squashed out on the way in.

## Secrets

None, for now. `GITHUB_TOKEN` is the built-in one, and it is enough to create a draft release.
Signing certificates ([`../code-signing-and-notarization.md`](../code-signing-and-notarization.md))
and the audit's model key ([`auditing-the-api-key-instructions.md`](auditing-the-api-key-instructions.md))
are the two things that will add repo secrets later, and both are their own plan.

## The repo must be public

Worth stating here because it constrains plan 4. `electron-updater` and any plain
releases-API check read release assets **unauthenticated**. On a private repo that requires a
token shipped inside the app, which is not a thing we will do. So either the repo is public
before releases start, or updates need a feed we host — and hosting a feed is a much larger
plan than any of these.

## As shipped

Both workflows exist, and `ci.yml` grew a second job of its own along the way (plan 5's link
check — see [`auditing-the-api-key-instructions.md`](auditing-the-api-key-instructions.md)).
The release side is four jobs rather than three, and everything the plan said about the version
assertion turned out to apply to publishing too.

- **The version assertion is its own job, not a step in the gate.** The plan drew it hanging off
  `gate`; it is `version`, running in parallel. It needs no submodules, no install and no cache,
  so a mistyped tag fails in seconds — and, more to the point, it fails as a red tick labelled
  *version* rather than as one labelled *gate*, which would read as "the tests broke". `build`
  needs both.

- **It asserts and never writes, and the same reasoning made `publish` refuse.** A re-run had to
  work — a matrix leg that failed on somebody else's outage is exactly the case for one — but
  `gh release create` refuses a tag it already has. So an existing **draft** is topped up with
  `gh release upload --clobber`, and an already **published** release is refused by name.
  Replacing the assets people are downloading is not something a re-run should be able to do
  quietly, and "the draft is still a draft" is the check that separates the two.

- **The build matrix uploads named files, not the output directory.** `apps/desktop/release/`
  also holds `win-unpacked/` and electron-builder's own debug dump. The list carries globs for
  targets not built yet (`*.dmg`, `*.zip`, `*.AppImage`) so that adding `macos-latest` really is
  the one line the plan promised, and `if-no-files-found: error`, because a packaging change that
  quietly stopped emitting an installer would otherwise reach a draft release as an empty one.

- **`latest*.yml` is in that list and it is not optional.** Without the update feed an installed
  copy's update check has nothing to read, which makes plan 4 a no-op against a release that
  otherwise looks complete. A local `pnpm package` confirms electron-builder writes `latest.yml`
  even under `--publish never`, and that the name inside it matches the installer on disk
  byte-for-byte — the `artifactName` line in `electron-builder.yml` is what makes that true.

- **No leg can publish even by accident.** `scripts/package.desktop.mjs` passes `--publish never`
  itself rather than the workflow passing it, so the property holds for a developer's local run
  as well.

**Owed.** No tag has been pushed. The version assertion was exercised locally in both directions
(a matching tag passes and names the version; `v0.2.0` against `0.1.0` fails and names both), and
the publish step's three branches were exercised against a stubbed `gh`. What that cannot stand
in for is the draft release itself and an installer built on a Windows runner rather than this
machine — and the first run of either workflow is blocked on the same unpushed `vendor/path.ux`
commit as `ci.yml`.

## Acceptance

- A push to a branch runs `ci.yml` and it passes.
- Tagging `v0.1.0` with a mismatched `package.json` version fails at the gate, naming both.
- Tagging it correctly produces a draft release with a Windows installer and `latest.yml`
  attached.
- The installer from that draft installs on a clean VM and opens a project.
