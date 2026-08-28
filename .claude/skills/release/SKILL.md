---
name: release
description: Cut a new release of the desktop app — bump apps/desktop/package.json's version, commit it, tag it (v<version>), push both, and watch the "Release" GitHub Actions workflow through to the draft-release result. Use when the user asks to "cut a release", "make a release", "release a new version", or "bump and tag" the desktop app.
---

# Release

Only `apps/desktop/package.json` carries a real version (everything else in the workspace is
`0.0.0`/private). `.github/workflows/release.yml`'s `version` job checks out the pushed tag and
asserts `v<tag> == apps/desktop/package.json`'s version — get that wrong and the whole workflow
fails in five seconds on the version job, before gate/build/publish run at all.

The release itself is a draft: `publish` job creates or tops up a **draft** GitHub release, and a
person decides when to actually publish it (that's the moment every installed copy's auto-update
check starts offering the build). This skill stops once the draft exists; it never publishes it.

## 1. Preconditions

Run `git status` and `git fetch`. Refuse to proceed (report back instead) if any of:

- Working tree is not clean.
- Current branch isn't `master`, or `master` is behind `origin/master`.
- `apps/desktop/package.json` has local uncommitted changes (it's about to be edited).

## 2. Decide the new version

Read the current version with `node -p "require('./apps/desktop/package.json').version"`.

If the user gave an explicit version, use it. If they said "patch"/"minor"/"major" (or said
nothing — default to patch), compute it via semver rules from the current version. Confirm
the resulting version with the user before touching anything if it was not explicit and not
an unambiguous default — a released version number is hard to take back once tagged and pushed.

## 3. Bump, commit, tag

1. Edit the `"version"` field in `apps/desktop/package.json` (`Edit` tool — it's a single-line
   field, don't touch anything else in the file).
2. Run `pnpm check && pnpm test && pnpm lint` locally first. The release workflow's `gate` job
   re-runs all three, but catching a break here costs a minute instead of a burned CI run and a
   tag that has to be deleted and re-pushed.
3. Commit, staging only that file:
   ```
   git add apps/desktop/package.json
   git commit -m "Bump desktop app version to <version>"
   ```
   Match the existing convention (`git log --oneline -- apps/desktop/package.json`) — no body
   beyond the trailers the Bash tool's commit instructions add.
4. Tag it: `git tag v<version>` (lightweight, matching `v0.1.0`/`v0.1.1`). Do not annotate unless
   the user asks — existing tags in this repo are lightweight.

## 4. Push — confirm first

Pushing to `master` and pushing a tag are both shared-state, hard-to-reverse actions
(`master` is linear/rebase-only per `CLAUDE.md`, and a pushed tag is what triggers the real
build/publish workflow — deleting and re-pushing a tag is disruptive, not free). Show the user
the commit and tag you're about to push and get explicit confirmation before running:

```
git push origin master
git push origin v<version>
```

Push the commit first, then the tag — the tag's `version` job checks out the tag itself, but
pushing the commit first means `master` and the tag never disagree even for a moment.

## 5. Monitor the Release workflow

The tag push triggers `.github/workflows/release.yml` (`name: Release`). Watch it rather than
reporting "pushed" and stopping:

```
gh run list --workflow=release.yml --branch v<version> --limit 1
gh run watch <run-id> --exit-status
```

If `gh run list` doesn't show the run yet, it can take a few seconds to register after the tag
push — retry briefly rather than concluding it didn't trigger. `gh run watch` blocks until the
run finishes; report the final per-job outcome (`version` / `gate` / `build` / `publish`) rather
than just pass/fail, since a `version` job failure specifically means the tag and
`apps/desktop/package.json` disagree (check for that first if it fails).

If it fails, do not delete/re-push the tag without asking — that's exactly the disruptive
re-tag scenario called out above; report what failed and ask how the user wants to proceed.

## 6. Report back

On success: link the run, and note that `publish` leaves a **draft** release
(`gh release view v<version>`) — tell the user it's ready for them to review and publish by hand,
and don't publish it yourself.
