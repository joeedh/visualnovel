import {
  CHECK_TIMEOUT_MS,
  COLLABORATING_GUIDE,
  RELEASES_API,
  RELEASES_PAGE,
  checkAgainst,
  runningVersion,
  unreachable,
  type UpdateCheck,
} from '../../distribution/updates.js';
import type { WorkspaceSession } from '../core.js';
import type { PromptResult } from '../types/results.js';

/**
 * Ask GitHub whether there is a newer VN Studio than this one.
 *
 * The decision is `updates.ts`'s and is pure; this is the request. Unauthenticated, so it is
 * rate-limited at 60 an hour per IP — fine for one desktop app, which is why nothing automated
 * may ever call this.
 *
 * It never throws. Every failure comes back as an `unreachable` verdict carrying its own
 * sentence, because a check the author did not ask for must be able to fail without filing an
 * `error` notification at someone mid-scene. `announcementFor` is what decides whether the
 * verdict is worth saying out loud.
 */
export async function checkForUpdates(session: WorkspaceSession): Promise<UpdateCheck> {
  const running = runningVersion(session.deps.appVersion ?? '');
  try {
    const response = await fetch(RELEASES_API, {
      headers: {
        accept      : 'application/vnd.github+json',
        // GitHub asks every client to name itself, and answers 403 to one that does not.
        'user-agent': `vnstudio/${running || 'dev'} (+${RELEASES_PAGE})`,
      },
      signal : AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // 403 and 429 are the rate limit, and 404 is a repository with no release yet. All three
    // are "no answer today" rather than anything the author can act on.
    if (!response.ok) return unreachable(running, `GitHub answered ${response.status}`);
    return checkAgainst(running, await response.json());
  } catch (err) {
    return unreachable(running, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Open VN Studio's own releases page — the notes and the installers are one page there.
 *
 * The address is derived from `ISSUE_REPO` rather than passed in, for the reason
 * `openKeyLink` states: nothing in this app opens a URL it was handed, and a notification
 * — a line of a file git union-merges across clones — is exactly the input that rule is for.
 */
export async function openReleases(session: WorkspaceSession): Promise<PromptResult> {
  const open = session.deps.openExternal;
  if (!open) return { ok: false, message: 'This build cannot open a browser.' };
  await open(RELEASES_PAGE);
  return { ok: true, message: `Opened ${RELEASES_PAGE}.` };
}

/** Open the collaborating guide, the page a refused send or get points at, in the browser. */
export async function openCollaboratingGuide(session: WorkspaceSession): Promise<PromptResult> {
  const open = session.deps.openExternal;
  if (!open) return { ok: false, message: 'This build cannot open a browser.' };
  await open(COLLABORATING_GUIDE);
  return { ok: true, message: `Opened ${COLLABORATING_GUIDE}.` };
}
