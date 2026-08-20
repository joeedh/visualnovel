/**
 * A notification: one durable, linkable event, one line of `vngen/state/notifications.jsonl`.
 *
 * Two things about the shape are load-bearing and are stated here because nothing downstream can
 * infer them:
 *
 * - `v` is per line, not per file. The log is union-merged by git, so two builds' lines end up
 *   interleaved in one file, and a file-level version field would describe half of them wrongly.
 * - `v`, `r` and `h` come first. `r` (read) and `h` (hidden) are single ASCII digits patched
 *   in place at a computed byte offset, so they must sit in the line's pure-ASCII head, ahead of
 *   authored text. Serializing must preserve that order.
 */
import { z } from 'zod';

/** What a notification is about. A string literal union, deliberately not a TS `enum`. */
export const NOTIFICATION_CATEGORIES = [
  'asset', // rendered, adopted, replaced, accepted
  'pipeline', // a run started, finished, halted at the gate
  'agent', // wrote files, finished a turn, asked
  'document', // a scene / sheet / wiki page was written
  'workspace', // project opened, created, reindexed
  'command', // an ordinary command's success or refusal
  'error', // something failed
  'debug', // instrumentation with nowhere else to land
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_LEVELS = ['info', 'warn', 'error'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** Who posted it. Kept separate from `category`: the same subject can arrive from either side. */
export const NOTIFICATION_SOURCES = ['ui', 'main', 'agent', 'pipeline', 'cdp'] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

/**
 * Where a notification points. A link names an act to perform rather than an address.
 *
 * There are two shapes because there are two kinds of destination. `editor` (with `subject`) is
 * the argument shape of the `view.open` command, so following a link runs the command the palette
 * and the menu already run. `command` names a whole command instead, for a notification whose
 * destination is not a pane: today only the releases page, reached through `app.openReleases`,
 * which derives its own URL.
 *
 * Neither field may be a URL. `app.openKeyLink` states the same rule: because a link names a
 * field rather than an address, no part of the app can ask the OS to open an address it was
 * handed. A notification is a line of a file git union-merges across clones and branches, so it
 * is exactly the kind of input that must not be able to name an address.
 *
 * Both are bare strings here rather than the desktop's `EditorId` or a command id, because those
 * live in `apps/desktop/src/shared/`, which this package sits below and must not import. The
 * desktop narrows each on the way out, an editor against `EDITOR_IDS` and a command against a
 * short allow-list. A link it cannot narrow leaves the row a plain unlinked message.
 *
 * Both fields are optional, which lets this widen without a `NOTIFICATION_VERSION` bump: every
 * line an older build wrote still parses, and a line written by this build with only a `command`
 * fails an older build's stricter schema and is skipped, the same way `migrateNotification`
 * skips anything it cannot use.
 */
export const NotificationLinkSchema = z.object({
  editor: z.string().min(1).optional(),
  subject: z.string().optional(),
  command: z.string().min(1).optional(),
});
export type NotificationLink = z.infer<typeof NotificationLinkSchema>;

/** The version this build writes. Bump alongside a new entry in `MIGRATIONS`. */
export const NOTIFICATION_VERSION = 1;

export const NotificationSchema = z.object({
  v: z.number().int().positive(),
  /** Read. 0 or 1 — a number, not a boolean, because it is patched as one ASCII digit. */
  r: z.union([z.literal(0), z.literal(1)]),
  /** Hidden ("archived"). Same contract as `r`. */
  h: z.union([z.literal(0), z.literal(1)]),
  id: z.string().min(1),
  /** ISO-8601. Sorts lexically, which is what the reader relies on. */
  at: z.string().min(1),
  /** One app launch, so debugging tooling can tell two runs apart in a merged log. */
  session: z.string().min(1),
  category: z.enum(NOTIFICATION_CATEGORIES),
  level: z.enum(NOTIFICATION_LEVELS),
  source: z.enum(NOTIFICATION_SOURCES),
  message: z.string(),
  link: NotificationLinkSchema.optional(),
});

export type Notification = z.infer<typeof NotificationSchema>;

/** Everything a caller supplies; `notify()` stamps the rest. */
export interface NotificationInput {
  category: NotificationCategory;
  message: string;
  level?: NotificationLevel;
  source?: NotificationSource;
  link?: NotificationLink;
}

/**
 * Lift a line written by an older build to the current shape, keyed by the `v` it was written at.
 * Empty at v1. The chain exists so the first schema change is an entry here rather than a
 * decision about what to do with existing logs.
 */
const MIGRATIONS: Record<number, (line: Record<string, unknown>) => Record<string, unknown>> = {};

/**
 * Parse one line, migrating it forward. Returns `undefined` rather than throwing for anything it
 * cannot use: a half-written line (what a crash mid-append leaves), a line that does not validate,
 * or a line whose `v` is newer than this build knows.
 *
 * This departs deliberately from the repo's usual `z.literal(1)`-and-throw (`@vn/store`'s
 * `readShots`). A shot file that silently re-decomposes corrupts art, so it must throw. A
 * notification log that refuses to open because one line came from a newer build loses every
 * other line with it, so skipping is the smaller loss. `main/threads.ts` reasons the same way.
 */
export function migrateNotification(raw: unknown): Notification | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;

  let line = { ...(raw as Record<string, unknown>) };
  const from = line['v'];
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) return undefined;
  if (from > NOTIFICATION_VERSION) return undefined;

  for (let v = from; v < NOTIFICATION_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return undefined;
    line = step(line);
  }

  const parsed = NotificationSchema.safeParse({ ...line, v: NOTIFICATION_VERSION });
  return parsed.success ? parsed.data : undefined;
}
