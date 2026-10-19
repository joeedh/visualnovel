/**
 * Schedules the missing-picture check and reports its result to the windows. The check itself is
 * `MissingPart` in the session; this module decides when it runs, pushes `missing:changed` when
 * the set changes, and files a notification for each newly missing picture.
 */
import { notifications } from '../notify/notifications.js';
import type { AppContext } from './context.js';
import { getSession } from './sessionaccess.js';

/** How long after an undo or a git command the check waits, so a burst of them checks once. */
const CHECK_DEBOUNCE_MS = 300;

const timers = new WeakMap<AppContext, ReturnType<typeof setTimeout>>();

/**
 * Runs the check, always or only when some repository's `HEAD` moved since the last one. Failures
 * are logged rather than thrown, since nobody waits on the answer.
 */
export async function checkMissing(ctx: AppContext, when: 'always' | 'moved'): Promise<void> {
  if (!ctx.workspaceRoot) return;
  try {
    const part = getSession(ctx).missingPart;
    const before = new Set(part.report.pictures.map((p) => p.hash));
    const report = when === 'always' ? await part.check() : await part.checkIfMoved();
    if (!report) return;
    const after = new Set(report.pictures.map((p) => p.hash));
    if (before.size !== after.size || [...after].some((hash) => !before.has(hash))) {
      ctx.broadcast('missing:changed', {});
    }
    const fresh = report.pictures.filter((p) => !before.has(p.hash));
    if (fresh.length === 0) return;
    const names = fresh.slice(0, 3).map((p) => p.label);
    const more = fresh.length > 3 ? ` and ${fresh.length - 3} more` : '';
    await notifications().post({
      category: 'asset',
      level   : 'warn',
      source  : 'main',
      message:
        `${fresh.length === 1 ? 'A picture the project uses is' : `${fresh.length} pictures the project uses are`} ` +
        `missing: ${names.join(', ')}${more}. History lists ${fresh.length === 1 ? 'it' : 'them'}, ` +
        'to bring back from git or stop using.',
      link    : { editor: 'history' },
    });
  } catch (err) {
    console.warn(`[vnstudio] could not check for missing pictures: ${String(err)}`);
  }
}

/** Coalesces a burst of triggers into one check. */
export function scheduleCheck(ctx: AppContext, when: 'always' | 'moved' = 'always'): void {
  if (timers.has(ctx)) return;
  const timer = setTimeout(() => {
    timers.delete(ctx);
    void checkMissing(ctx, when);
  }, CHECK_DEBOUNCE_MS);
  timer.unref?.();
  timers.set(ctx, timer);
}
