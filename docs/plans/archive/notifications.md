# Notifications: one system, stored in the repo, linkable

Status: **shipped**

Before this, the app had no notification system. It had `say(text, bad)` in
`apps/desktop/renderer/pathux/bridge.ts`, which called path.ux's `message`/`error`. Those
broadcast through `sendNote` to **every** `noteframe-x` on screen, and every editor had one
because `VnEditor.init()` called `makeHeader(container, true)`. One sentence appeared
simultaneously in all thirteen headers, lasted four seconds, and was then gone forever.

This plan narrowed the transient display to one place — the menu bar — and added a durable,
linkable, filterable notification log stored in the project repo, with everything routed through
it. Everything is persisted deliberately, for debugging: each entry carries a session id, so
tooling written later can tell two app launches apart in a merged log.

<!-- toc -->

- [The shape of a notification](#the-shape-of-a-notification)
  - [Versioning is per line](#versioning-is-per-line)
  - [Two digits reserved at the head](#two-digits-reserved-at-the-head)
- [The log](#the-log)
  - [Reading](#reading)
  - [Patching a flag](#patching-a-flag)
  - [The hub, and why it buffers](#the-hub-and-why-it-buffers)
- [Merging](#merging)
- [Where notifications come from](#where-notifications-come-from)
  - [Every command outcome](#every-command-outcome)
  - [The pipeline](#the-pipeline)
  - [Notices the shell raised itself](#notices-the-shell-raised-itself)
  - [What is deliberately not filed](#what-is-deliberately-not-filed)
- [Saying it once](#saying-it-once)
- [Commands](#commands)
- [The UI](#the-ui)
  - [One note frame](#one-note-frame)
  - [The bell](#the-bell)
  - [The list](#the-list)
  - [The filter](#the-filter)
  - [The funnel icon](#the-funnel-icon)
- [Files](#files)
- [Deviations from the plan as approved](#deviations-from-the-plan-as-approved)
- [Future work](#future-work)

<!-- tocstop -->

## The shape of a notification

`packages/types/src/notifications.ts`. Categories, levels and sources are string literal unions
built from `as const` arrays — deliberately **not** TS `enum`s, so nothing has to import a value
to name a category:

```ts
export const NOTIFICATION_CATEGORIES = [
  'asset', 'pipeline', 'agent', 'document', 'workspace', 'command', 'error', 'debug',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
```

`z.enum(NOTIFICATION_CATEGORIES)` yields exactly that union. `NOTIFICATION_LEVELS` is
`info | warn | error`; `NOTIFICATION_SOURCES` is `ui | main | agent | pipeline | cdp` — who
posted it, kept separate from `category`, because the same subject arrives from either side.

One line of `vngen/state/notifications.jsonl`:

```jsonc
{"v":1,"r":0,"h":0,"id":"20260816-141203-a7f2","at":"2026-08-16T14:12:03.221Z",
 "session":"20260816-140011-9c1d","category":"asset","level":"info","source":"pipeline",
 "message":"Rendered cafe — night plate.","link":{"editor":"asset","subject":"3f9a…"}}
```

`link` is optional and is **deliberately the argument shape of `view.open`**, so following a link
invents nothing: it runs the command the palette and the menu already run. `editor` is a bare
`z.string()` here rather than the desktop's `EditorId`, because that union lives in
`apps/desktop/src/shared/editors.ts`, which `@vn/types` sits below and must not import. The
desktop narrows it on the way out (`linkTarget` in `src/shared/notify.ts`) and refuses a link
naming an editor this build does not have.

**Since [`in-app-update-checks.md`](in-app-update-checks.md), a link may name a whole command
instead** — `"link":{"command":"app.openReleases"}` — for a notification whose destination is not
a pane. The rule under both shapes is the same and is the point: a link names an **act**, never an
address. `app.openReleases` derives its own URL from `ISSUE_REPO`, so the log says what to do and
the app still decides where that goes; `app.openKeyLink` states the same rule for the Setup pane's
buttons. `linkCommand` narrows against a short allow-list rather than against the whole registry,
because this file is tracked and git union-merges it — a line asking a click to start a paid
`pipeline.run` can arrive from somebody else's branch. Both fields are optional, which is what let
this widen with no `v` bump: an old line still parses, and a new one an old build cannot read is
skipped exactly like anything else it cannot use.

### Versioning is per line

`v` is on each line, not on the file. The log is union-merged by git, so two builds' lines end up
interleaved in one file and a file-level version field would be a lie about half of them.

`migrateNotification(raw)` lifts an older line forward through a `MIGRATIONS` chain keyed by the
`v` it was written at, then validates. It returns `undefined` — never throws — for a line it
cannot use: a half-written trailing line (what a crash mid-append leaves), a line that does not
validate, or one whose `v` is *newer* than this build.

That is a deliberate departure from the repo's usual `z.literal(1)`-and-throw
(`@vn/store`'s `readShots`). A shot file that silently re-decomposes corrupts art, so it must
throw. A notification log that refuses to open because one line came from tomorrow's build loses
every other line with it; skipping is the smaller loss. `main/threads.ts` reasons the same way.

### Two digits reserved at the head

`r` (read) and `h` (hidden) are **numbers, 0 or 1, not booleans**, and they sit third and fourth
in the object, right after `v`. Marking a notification read is then a one-byte write at a computed
offset — no rewrite of the file, and no growth of the log from state changes.

`JSON.stringify` preserves insertion order, so `buildNotification` constructing the object in that
order is the whole mechanism. **The key order is load-bearing** and is pinned by a test.

## The log

The *path* lives in `@vn/store` beside the other logs
(`ProjectPaths.notificationsLog` → `vngen/state/notifications.jsonl`). The *reader and writer*
live in `apps/desktop/src/main/notifications.ts`, following `main/threads.ts`, whose header
comment already argues the case: `vngen/state/` is where this project keeps its append-only logs,
but a transcript — and a notification — is not one of a *project's authored files*, so it does not
belong in the package that models those. Nothing in the format assumes the desktop.

### Reading

`readNotifications(file)` reads, splits on `\n`, migrates each line (skipping failures), dedupes
by `id` while **ORing** `r` and `h`, and sorts by (`at`, `id`). A missing file is `[]`, not an
error. A trailing `\r` is tolerated, so a file that arrived through some other checkout still
parses.

### Patching a flag

`setNotificationFlags(file, id, { read?, hidden? })` is the only place that knows the byte-level
contract, and it **never decodes to a string**. It reads the file as a `Buffer`, splits on `0x0A`
accumulating each line's start offset *in bytes*, finds the line containing `"id":"<id>"`, locates
`"r":` within that Buffer slice, verifies the byte there is `0x30` or `0x31`, and writes the one
ASCII digit through an `fs.open(path, 'r+')` handle.

**The hazard is the earlier lines, not this one.** The head of each line is pure ASCII, but a
`utf8`-decoded string's index into the *file* runs short by one for every extra byte of every
multi-byte character above it — and this codebase's own messages are full of them (`⟲`, `⟳`, `…`,
em-dashes). Decode-then-index patches the wrong byte in any file whose earlier lines hold
non-ASCII. The test for this puts `⟲ Undid "Rename scene" — 3 files…` on the line *before* the one
being patched and asserts both that the flag flipped and that the earlier message round-trips
byte-identical.

Every line matching the id is patched, not just the first: a union merge can leave two.

### The hub, and why it buffers

`NotificationHub` holds `pending` posts until `open()` is called, and `suspend()` puts it back to
sleep when the workspace closes. Two reasons, both of which would otherwise be bugs:

- **The log path is resolved lazily, per call, from the workspace open *now*.** A captured
  `ProjectPaths` that wrote a notification into a new project's root before `inspectCreate` ran
  would make `workspace.create` fail outright — it refuses a directory that is not empty.
- **`openRepos()` runs `committer().checkpoint('Changes made outside the app')`.** Anything
  written to `vngen/state` before that point is swept into a commit with that title on *every*
  launch. So `notifications().open()` is the last thing `openRepos()` does, and posts made before
  it are held in memory and flushed after.

A notification posted while no workspace is open is dropped, and that is correct — the log belongs
to a project.

`SESSION_ID` is module scope: `${stamp}-${randomBytes(2).toString('hex')}`, one per app launch.

## Merging

The project repo gets `vngen/state/notifications.jsonl merge=union` in its `.gitattributes`, in
three places: as a fourth entry in `skeleton()` for new projects, through an idempotent
`ensureGitAttributes(root)` in `openWorkspace`, and through `adoptGitAttributes(root)` in
`openRepos()` — so projects created before this plan get the line appended once. On an existing
repo the ensure is committed on its own, as "Union-merge the notification log", rather than being
swept into the open-time "Changes made outside the app" checkpoint.

The third site is the one that actually reaches most projects: `openWorkspace` runs only for an
explicit `workspace.open`, while an ordinary launch resolves a root from the recents list or
`VN_PROJECT` and goes straight to `openRepos()`. `adoptGitAttributes` sits there between
`ensureRepo` and the checkpoint, and is skipped when the project sits inside a larger repo.

Union merge duplicates a line whose flags each side changed. That is exactly what the reader's
dedupe-and-OR handles: `r` and `h` are monotonic, so the set bit wins and the timestamps make the
order deterministic.

This repo's `* text=auto eol=lf` is deliberately **not** copied into `skeleton()`. `merge` and
`text`/`eol` are orthogonal attributes; a project is the user's repo, and inheriting our
line-ending policy into it is not this plan's business.

**Committer churn is expected, not a bug.** `Committer.commit` stages the whole worktree, so
notification writes ride along in the next act's commit. `vngen/state/commands.jsonl` has always
behaved this way, and the open-time checkpoint sweep exists to absorb it.

## Where notifications come from

Everything routes through one main-side `notify(input)`, which stamps `id`, `at` and `session`,
appends, and pushes a `notify:changed` event so the bell and an open list update live.

### Every command outcome

One hook in `apps/desktop/src/main/index.ts`'s `onRecord`, which fires for every record — ok and
error, from the palette, a menu, the agent or CDP. That single call replaced roughly thirty
renderer `say(outcome.record.message)` sites.

What gets filed is decided by `shouldFileCommand(record)` in `src/shared/notify.ts` — a predicate
with tests rather than an inline condition, because two of its rules are not obvious:

- **Non-mutating successes are not filed.** They are UI reads, and `workspace.recent` runs on
  every header rebuild.
- **`notify.*` is never filed.** Otherwise marking one read files another, and emptying the log
  refills it.

Errors are always filed, whether or not the command mutates. `categoryOfCommand(id)` maps the
namespace (`asset.*` → `asset`, `story.*`/`doc.*` → `document`, and so on) with `command` as the
fallback; a failure is filed under `error` regardless of namespace.

A refusal reaches `onRecord` as a throw, so it arrives with `status: 'error'` and its own reason.
The handful of failures the stack rejects *before* a record exists — unparseable DSL, an unknown
command, invalid props, a missing or declined confirm gate — carry no record and are shown by the
renderer instead.

### The pipeline

`WorkspaceSession.announceRun` files one `asset` notification per task the run finished, each
linked `{ editor: 'asset', subject: <asset hash> }` and labelled with `assetSlotLabel` so it reads
"Rendered cafe — night plate." rather than a hash; one `error` notification per failure; and one
`pipeline` notification for the run itself.

No change to the scheduler and no manifest diff was needed: `RunSummary.ran` is already
`AnyTask[]`, and `runPipeline` was throwing it away with `ran: summary.ran.length`. The manifest
is read inside the same closure that ran the pipeline, while that project is still in hand.

### Notices the shell raised itself

A few things the renderer says are not a command's outcome — a rule module's refusal, a box left
empty, no save found. Those call a renderer `notify()` in `bridge.ts`, which posts over
`notify:post`. They are *not* shown from there: main pushes every notification back, and that push
is what displays it. The asset editor wraps this as a private `complain(message)`.

### What is deliberately not filed

The private `this.say(Notice | null)` verdict strips in `editors/script.ts`, `editors/branch.ts`
and `editors/timeline.ts`. Those update on every pointer move — they are mid-gesture previews, not
events, and logging them would bury the log. The asset editor's drag refusals *are* filed, because
those fire once per gesture rather than per frame.

The disabled-entry sentence a context menu shows when it draws a refused command is also not
filed: nothing was attempted.

## Saying it once

With main filing and pushing everything, a call site that also said the sentence would show it
twice. One rule, in `bridge.ts`:

```ts
export function report(outcome: CommandOutcome): void {
  if (!outcome.ok) {
    if (!outcome.record) say(outcome.error, true);
    return;
  }
  if (!shouldFileCommand(outcome.record)) say(outcome.record.message);
}
```

`report` voices exactly what the push will not: a read that succeeded, and a failure the stack
rejected before a record existed. Every former `say(outcome.record.message)` site is now
`report(outcome)`. `move()` (undo/redo) uses it too — `stack.undo` writes a `mutating` record, so
the push says it.

## Commands

`apps/desktop/src/main/commands/notify.ts`. Commands are the only write path, so every state
change is one. None is `undoable`: `vngen/state` is outside `UNDO_PATHS`, exactly as `agent.ts`
already reasons for threads.

| Command | Props | Does |
| --- | --- | --- |
| `notify.list` | — | reads; `data` is the log, message is the count |
| `notify.markRead` | `id` | one-byte flag write |
| `notify.hide` | `id` | ditto |
| `notify.unhide` | `id` | the Undo behind the "archived" row |
| `notify.clear` | `ids` | hides each — the visible set, computed by the list |
| `notify.deleteAll` | — | `confirm: true`, `mutating`; truncates the file |
| `notify.follow` | `id` | marks read, then follows the link — its editor, or the act it names |

`notify.clear` takes the visible ids rather than recomputing the filter in main. That is what
keeps "respects the active filter" honest: the filter lives in the session store, and the list is
the thing that knows what it drew.

`notify.deleteAll` declares a `check` that refuses when the log is empty. It has to: the command
tests assert that every mutating command declares one.

Reads go over `notify:list`; renderer-raised notices over `notify:post`; the push is
`notify:changed`.

## The UI

### One note frame

`VnEditor` gained `protected get wantsNoteArea(): boolean { return false; }`, consumed by the one
`makeHeader(this.container, this.wantsNoteArea)` call. `VnHeaderEditor` overrides it to `true`.
`getNoteFrames` now finds exactly one place to put a sentence.

Two path.ux landmines had to be handled in the survivor:

- `makeHeader` runs inside `super.init()`, **before** `VnHeaderEditor` takes
  `this.bar = this.header.row()`, so the frame would sit at the far left in front of the brand.
  `placeNoteArea()` re-adds it after, which moves it in the shadow root.
- **An auto margin does not survive on a path.ux widget.** `saneStyle` *is* `this.style`, and
  `setBoxCSS` sets `margin: unset` and rewrites every side from the theme. `setCSS()` fires on
  hover, on press, on enable/disable and on every `flushUpdate`, so a plain
  `style['marginLeft'] = 'auto'` is erased moments later. The margin goes through
  `setCSSAfter(() => …)`, the hook path.ux itself uses for this in `ScreenArea.ts`.

### The bell

A glyph button at the right of the bar, matching the existing `⟲`/`⟳` buttons, labelled `🔔` or
`🔔 3`. The count is `ShellState.unread`, pushed by `pathux/notifications.ts` rather than counted
in the header — so the badge and the list can never disagree about which ones count — and added to
`stateKey()` so the bar rebuilds when it changes. Its `.description` says what it does.

### The list

`renderer/pathux/notifications.ts`, modelled on `dialog.ts`: a module-level singleton, a popup
anchored top-right, a wrapped `popup.end` so Escape and click-outside clear it, and a scrolling
`col()` with `overflowY: 'auto'` and a `maxHeight`.

Each row is a full-width button — `● [category] message` — running `notify.follow`, plus a small
`×` running `notify.hide`. Clicking a row marks it read but does **not** hide it. On `×`, the
row's contents are replaced **in place** — the same row object, so the layout space is kept — with
"archived" and an "undo" button running `notify.unhide`.

The header holds `Clear` (which hides everything the list is currently showing, so it respects the
filter), a "show deleted" checkbox, the funnel, and a `⋯` menu with
"Delete all notifications permanently…" opening `notify.deleteAll`'s form. That is the house
confirm pattern — a `confirm: true` command re-labels its own run button — so no new confirm
widget was needed.

An empty list says *why* it is empty in terms of what the author can change: nothing has happened,
every category is filtered off, nothing matches, or everything is archived.

Every widget carries a `.description` (path.ux widgets take `.description`, not `.title`).

The pure half is `apps/desktop/src/shared/notify.ts` — `visibleNotifications`, `unreadCount`,
`categoryOfCommand`, `shouldFileCommand`, `linkTarget` — with a `tests/` sibling. It is in
`src/shared/` rather than `renderer/rules/` because main needs `categoryOfCommand` and
`shouldFileCommand` too, and one copy is the point. `unreadCount` deliberately ignores
`showHidden`: an archived notification does not become unread again by being shown.

### The filter

A second popup, not a mode. One `check` per entry of `NOTIFICATION_CATEGORIES` — drawn from the
union itself, so a category added to `@vn/types` cannot go unfilterable — plus "Clear filters",
which turns them all **off**. Off rather than on is what makes "clear, then tick the one you want"
the fast path; a button that turned everything back on would be the default already.

Filter state (categories, "show deleted") is a UI preference, so it persists in the desktop
`SessionStore` under `vn.notifications.filter`, not in the repo. A stored category this build no
longer has is narrowed away on restore, rather than sitting in the filter forever, invisible in
the popup and quietly hiding rows.

### The funnel icon

The app had no `iconbutton` call sites and every editor passes `icon: -1`. One custom icon is
registered in `renderer/pathux/icons.ts` from an inline SVG data URL.

**`addCustomIcon` calls `regenIcons()` synchronously**, drawing from an image that may not have
decoded yet, and `toBlob` is async on top — registering eagerly yields a blank tile. So
`installIcons()` stays synchronous and registration happens from `image.decode().then(…)`. The id
is a mutable `VN_ICONS.filter` initialised to `-1`; the list draws a text "Filter" button while it
is still `-1` and an `iconbutton` once it is not. A decode that never lands costs a glyph, not a
missing control.

## Files

**New:** `packages/types/src/notifications.ts`, `apps/desktop/src/main/notifications.ts`,
`apps/desktop/src/main/commands/notify.ts`, `apps/desktop/src/shared/notify.ts`,
`apps/desktop/renderer/pathux/notifications.ts`, `apps/desktop/renderer/pathux/icons.ts`, and
`tests/` siblings for the three pure modules.

**Modified:** `packages/types/src/index.ts`, `packages/store/src/paths.ts`,
`apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/index.ts`,
`apps/desktop/src/main/session.ts`, `apps/desktop/src/main/workspace.ts`,
`apps/desktop/src/main/commands/index.ts`, `apps/desktop/renderer/api.ts`,
`apps/desktop/renderer/pathux/{editor,bridge,shell,state,showmenu,commandform}.ts`, and
`apps/desktop/renderer/pathux/editors/{header,asset,play,project,wiki}.ts`.

## Deviations from the plan as approved

- **The pure logic went to `apps/desktop/src/shared/notify.ts`, not
  `renderer/rules/notifications.ts`.** Main needs `categoryOfCommand` and `shouldFileCommand`, and
  a rules module the main process cannot import would have meant two copies of the mapping.
- **`shouldFileCommand` is a tested predicate**, not the inline "post on success, post on refusal"
  the plan described. Its two exclusions — non-mutating successes, and `notify.*` — are the
  difference between a log and a flood.
- **`say()` did not gain a category parameter.** With main filing from `onRecord`, `say` stayed
  the transient display and `report`/`notify` became the two things call sites reach for. Nothing
  files by calling `say`.
- **The event channel is `notify:changed`, one channel**, rather than `notify:new` plus a separate
  flag-change signal. The renderer's answer to both is a refetch, so two channels bought nothing.
- **The workspace-opened sentence was removed from the `command:ui` handler.** Whichever command
  opened the project is mutating, so main files and pushes its message; a second sentence there
  showed the same open twice.

## Future work

- **Live per-task progress.** A run is one blocking round trip today, so its notifications all
  arrive at the end. Streaming them would mean an `onTask` hook on `RunOptions` — a change to the
  pipeline spine for the same user-visible result — so it is deliberately not here.
- **Notifications from `vnauthor`.** Nothing in the format assumes the desktop. If the REPL wants
  to post, `main/notifications.ts` moves down a layer and both hosts read the same file.
- **Debugging tooling over `session`.** The session id exists so a later tool can separate two
  launches in a union-merged log. Nothing reads it yet.
