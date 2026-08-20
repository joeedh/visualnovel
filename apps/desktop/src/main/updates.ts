/**
 * Whether a newer VN Studio exists — stage 1 of
 * [`docs/plans/archive/in-app-update-checks.md`](../../../../docs/plans/archive/in-app-update-checks.md): read the
 * releases feed, compare, tell the author, and open the page if they want it. Nothing here
 * downloads or installs anything, and nothing here runs unless it is asked to.
 *
 * Everything that decides is in this file and is pure. The request itself and the browser are
 * `session.ts`'s, which is the same split `keyaudit.ts` uses and here has a second reason: the
 * unauthenticated GitHub API allows 60 requests an hour per IP, which is generous for one desktop
 * app and not remotely generous for a CI runner shared by every job on it. **No test may make
 * this call.** The functions below take a payload; they never fetch one.
 */
import { ISSUE_REPO } from '@vn/agentreport';
import type { NotificationInput } from '@vn/types';
import { z } from 'zod';
import { LINK_COMMANDS } from '../shared/notify.js';

/**
 * `releases/latest` rather than a listing of releases, because it already excludes prereleases
 * and drafts. That is the whole of the plan's "a prerelease tag is ignored" — a rule enforced by
 * choosing the endpoint is one no later edit here can forget.
 */
export const RELEASES_API = `https://api.github.com/repos/${ISSUE_REPO}/releases/latest`;

/**
 * Where an author is sent. The notes and the installers are the same page on GitHub, so the two
 * buttons the plan drew ("Release notes", "Download") are one destination.
 */
export const RELEASES_PAGE = `https://github.com/${ISSUE_REPO}/releases/latest`;

/** How long to wait before deciding GitHub is not answering. A check nobody asked for may not hang. */
export const CHECK_TIMEOUT_MS = 8000;

/**
 * Only the fields a verdict turns on. GitHub sends about seventy more, and validating the ones we
 * ignore would make this build fail on a field GitHub added rather than on one it removed.
 */
export const LatestReleaseSchema = z.object({
  tag_name: z.string(),
  prerelease: z.boolean().optional(),
  draft: z.boolean().optional(),
});

export type LatestRelease = z.infer<typeof LatestReleaseSchema>;

/**
 * What a check concluded.
 *
 * `unreadable` and `unreachable` are separate because they are different problems: the first is
 * ours (a tag that is not a version we can compare), the second is the network's. Neither is an
 * error — see {@link announcementFor} for why nothing in this file throws.
 */
export const UPDATE_STATES = [
  'available',
  'current',
  'ahead',
  'unreadable',
  'unreachable',
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

export interface UpdateCheck {
  state: UpdateState;
  /** The version this build reports, `x.y.z`, or whatever was found where one should have been. */
  running: string;
  /** The released version, present only when one could be read. */
  latest?: string;
  /** One sentence, written to be the whole answer on its own. */
  message: string;
}

/** Exactly `x.y.z`, optionally with a leading `v`. The only shape a release of this ever has. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * A version as three numbers, or `undefined` for anything else.
 *
 * Deliberately not a semver dependency. Prereleases never reach this — `releases/latest` filters
 * them — and build metadata is not something this repo's tags carry, so the grammar the plan said
 * to write by hand is the whole grammar there is. Anything outside it is reported as unreadable
 * rather than guessed at.
 */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative if `a` is older, zero if they match, positive if `a` is newer. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The bare version out of what the app says about itself. `describeVersion` writes `0.1.0` when
 * packaged and `0.1.0 (dev abc1234)` from a checkout, so the version is the first token either
 * way — and a development build is compared like any other rather than being exempt, because
 * "is there something newer than this" has the same answer for both.
 */
export function runningVersion(described: string): string {
  return described.trim().split(/\s+/)[0] ?? '';
}

/** The feed could not be read at all. Not a throw: see {@link announcementFor}. */
export function unreachable(running: string, why: string): UpdateCheck {
  return {
    state: 'unreachable',
    running,
    message: `Could not reach the release list (${why}). See ${RELEASES_PAGE}.`,
  };
}

/**
 * The verdict, given what this build is and what GitHub answered.
 *
 * `ahead` is its own state rather than being folded into `current`: it is what anyone running
 * from a checkout between releases sees, and telling them they are up to date when they are
 * carrying unreleased code is a small lie that makes the whole check harder to trust.
 */
export function checkAgainst(running: string, payload: unknown): UpdateCheck {
  const release = LatestReleaseSchema.safeParse(payload);
  if (!release.success) {
    return {
      state: 'unreadable',
      running,
      message:
        'Could not read the release list — GitHub answered something that is not a release. ' +
        `See ${RELEASES_PAGE}.`,
    };
  }

  const here = parseVersion(running);
  const there = parseVersion(release.data.tag_name);
  if (!here) {
    return {
      state: 'unreadable',
      running,
      message: `This build reports its version as “${running}”, which cannot be compared against a release.`,
    };
  }
  if (!there) {
    return {
      state: 'unreadable',
      running,
      message: `The latest release is tagged ${release.data.tag_name}, which is not a version this can compare against.`,
    };
  }

  const latest = there.join('.');
  const diff = compareVersions(there, here);
  if (diff > 0) {
    return {
      state: 'available',
      running,
      latest,
      message: `v${latest} is available — you have v${running}.`,
    };
  }
  if (diff < 0) {
    return {
      state: 'ahead',
      running,
      latest,
      message: `You are running v${running}, which is ahead of the latest release (v${latest}).`,
    };
  }
  return { state: 'current', running, latest, message: `You are up to date — v${running}.` };
}

/**
 * The durable notification a check earns, or `undefined` for one that earns none.
 *
 * Two rules, and both are the plan's:
 *
 * - **An available update is always announced**, quiet or not. That is the entire point of the
 *   periodic check, and it is the one thing here worth surviving the frame being dismissed.
 * - **A failure is announced only when a person asked.** A background check that could not reach
 *   GitHub has nothing to say to someone in the middle of writing a scene. This is also why
 *   nothing in this file throws: a command that threw would be filed as an `error` by
 *   `shouldFileCommand` whatever `quiet` said, which is precisely the notification the plan is
 *   trying not to post.
 *
 * The link names a *command*, never a URL. `app.openReleases` derives its own address from
 * `ISSUE_REPO`, so a notification — a line of a file git union-merges across clones — can ask for
 * the releases page and cannot ask for anything else.
 */
export function announcementFor(check: UpdateCheck, quiet: boolean): NotificationInput | undefined {
  if (check.state === 'available') {
    return {
      category: 'command',
      level: 'info',
      source: 'main',
      message: `${check.message} Open the releases page to read what changed and download it.`,
      link: { command: LINK_COMMANDS.releases },
    };
  }
  if (quiet) return undefined;
  if (check.state === 'unreachable' || check.state === 'unreadable') {
    return {
      category: 'command',
      level: 'warn',
      source: 'main',
      message: check.message,
      link: { command: LINK_COMMANDS.releases },
    };
  }
  return undefined;
}
