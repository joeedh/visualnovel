# Desktop session storage + draggable rails

**Status: implemented.** One deviation from §1 as written: `SessionStore.open(dir?, onChange?)`
takes an optional listener, fired on every `set`. That is what makes `view.panelSize` move the
panel live — main hangs the `session:changed` broadcast off it, so no write path can forget to
announce itself, whether it came from a drag or a command.

## Context

The desktop app's panel widths are hard-coded CSS grid tracks: `.studio { grid-template-columns: 212px 1fr }`
(`apps/desktop/renderer/styles.css:202-213`) for the STUDIO rail and `.floor-body { grid-template-columns: 1fr 320px }`
(`styles.css:855-859`) for the FLOOR inspector. Nothing in the app is resizable — a grep for
`resiz|onPointerDown|drag|splitter` across `apps/desktop` turns up only `draggable={false}` on two `<img>` tags.
The user can't widen the rail to read long character names, and there's nowhere to put a width if they could:
the app has **no app-level persistence at all** (no `userData` use, no `electron-store`; the only surviving
renderer state is `Runner.tsx`'s manual localStorage save-game).

This plan adds two things, in dependency order:

1. **A desktop session store** — a small, concurrency-tolerant key/value file store in the main process,
   writing `.vndesktop/session.json`. It lives under `apps/desktop/` for now with a one-line move to the user's
   home directory later, and is gitignored. Multiple app instances may read and write it simultaneously.
2. **A reusable resizable-panel hook + handle** in the renderer, keyed off a `saveId` prop, applied to both the
   STUDIO rail (left edge) and the FLOOR inspector (right edge) so the abstraction is proven against both
   orientations rather than being a rail-shaped one-off.

Decisions confirmed with the user: state is **global per install** (not per workspace); **both** panels get
converted now; and panel width is **also settable as a command** (`view.panelSize`) so layout is scriptable
from CDP, per CLAUDE.md's "every desktop action is a registered command".

---

## 1. The session store (main process)

**New: `apps/desktop/src/main/sessionstore.ts`**

```ts
export type SessionValue = string | number | boolean | null | SessionValue[] | { [k: string]: SessionValue };

export function resolveSessionDir(): string;   // VN_DESKTOP_HOME ?? <apps/desktop>/.vndesktop
export class SessionStore {
  static open(dir?: string): Promise<SessionStore>;
  snapshot(): Record<string, SessionValue>;
  get<T extends SessionValue>(key: string, fallback: T): T;
  set(key: string, value: SessionValue): void;   // in-memory + schedules a debounced flush
  flush(): Promise<void>;
  close(): Promise<void>;                        // flush now; called on app `before-quit`
}
```

- **Location.** `resolveSessionDir()` returns `process.env.VN_DESKTOP_HOME ?? join(__dirname, '..', '..', '.vndesktop')`.
  At runtime `__dirname` is `apps/desktop/dist/main`, so that resolves to `apps/desktop/.vndesktop`. A short comment
  marks the future `join(homedir(), '.vndesktop')` swap — the env override also makes the store trivially testable.
- **File.** `<dir>/session.json`, a flat `Record<string, SessionValue>` with dotted keys (`panel.studio.rail.width`).
  Missing or corrupt file → `{}` plus a `warn`; the store never throws on read.
- **Multi-instance tolerance** — three mechanisms, all needed:
  - **Cross-process lock.** `fs.mkdir('<dir>/session.lock')` is atomic and fails `EEXIST` when held. Acquire with
    `retry(fn, { attempts, baseMs })` from `@vn/util` (`packages/util/src/pool.ts:29`); break a lock whose mtime is
    older than ~5s (a crashed instance); always `rmdir` in a `finally`.
  - **Per-key merge, not per-file overwrite.** `set()` records the key as dirty. `flush()` re-reads the file _inside_
    the lock, applies only the dirty keys over what it finds, writes, and adopts the merged result as the new cache.
    An instance therefore never clobbers keys another instance owns. Same key from two instances is last-flush-wins —
    that's the honest contract, and it is fine for a rail width.
  - **Atomic write + EPERM retry.** Reuse `writeFileAtomic` from `@vn/util` (`packages/util/src/fs.ts:14`) wrapped in
    `retry` — the lock already serializes writers, but a concurrent _reader_ holding the target open can still make
    the rename fail with `EPERM` on Windows. The existing `*.tmp-*` gitignore entry already covers its temp siblings.
- **Debounce.** `set()` schedules a flush ~200 ms out and coalesces; `close()` flushes immediately. A drag persists
  once on pointer-up anyway (see §3), so this is belt-and-braces against write storms.

**New: `apps/desktop/src/main/tests/sessionstore.test.ts`** (the `@vn/desktop` jest project already matches
`apps/desktop/**/tests/*.test.ts`, `jest.config.cjs:61-66`). Cover: round-trip through a fresh instance; two stores over the
same dir each setting a different key, both keys survive; corrupt JSON → `{}` and still writable; a stale lock dir is
broken rather than deadlocking.

## 2. IPC surface

**`apps/desktop/src/shared/ipc.ts`** — export `SessionValue`, and add:

```ts
interface InvokeChannels { 'session:set': (p: { key: string; value: SessionValue }) => void; /* … */ }
interface EventChannels  { 'session:changed': { key: string; value: SessionValue }; /* … */ }
interface DesktopApi {
  invoke…; on…;
  /** Synchronously-available persisted UI state; see `SessionStore`. */
  session: { initial(): Record<string, SessionValue>; set(key: string, value: SessionValue): void };
}
```

**`apps/desktop/src/main/index.ts`** — a `getSessionStore()` singleton alongside `getSession()`/`getStack()`;
`handle('session:set', …)` inside `registerIpc()` (which also broadcasts `session:changed` back to the window, so a
command-driven change moves the UI); `app.on('before-quit', …)` calls `close()`. Plus one **synchronous** channel
registered directly (not through the typed `handle` helper, which is `ipcMain.handle`-only):

```ts
ipcMain.on('session:snapshot:sync', (e) => {
  e.returnValue = getSessionStore().snapshot();
});
```

**`apps/desktop/src/preload/index.ts`** — `session.initial()` calls `ipcRenderer.sendSync('session:snapshot:sync')`
once at preload time. This is deliberate: an async fetch would paint the rail at 212 px and then jump to the saved
width. The payload is a few hundred bytes read from an already-warm in-memory cache.

**`apps/desktop/renderer/api.ts`** — the browser-preview `fallback` gets a `session` implementation backed by
`localStorage`, so the Vite-only preview keeps working (same pattern as the existing mock switch).

## 3. Reusable resizable panels (renderer)

**New: `apps/desktop/renderer/session.ts`**

```ts
export function useSessionValue<T extends SessionValue>(key: string, fallback: T): [T, (v: T) => void];
```

Initial state comes from `api.session.initial()[key]` (synchronous → no flash), writes go through
`api.session.set`, and an `api.on('session:changed')` subscription picks up changes made by the command path.
This is the app's second `api.on(...)`-with-unsubscribe consumer; it follows the `command:ui` effect pattern in
`App.tsx:85-90`.

**New: `apps/desktop/renderer/Resizable.tsx`**

```ts
usePanelWidth(saveId: string, opts: { defaultWidth: number; min: number; max: number; edge: 'left' | 'right' })
  → { width, trackStyle, handleProps }
```

- Storage key is **derived from the `saveId` prop**: `panel.${saveId}.width`. Callers pass `'studio.rail'` /
  `'floor.inspector'`; nothing else about the key is the caller's business.
- `trackStyle` is `` { '--panel-w': `${width}px` } ``, spread onto the grid container. Each container declares its own
  track — `.studio { grid-template-columns: var(--panel-w, 212px) 1fr }` and
  `.floor-body { grid-template-columns: 1fr var(--panel-w, 320px) }` — which is what lets one hook serve a
  left-edge and a right-edge panel unchanged.
- `handleProps` carries the pointer handlers plus absolute positioning (`{ left: width }` for `edge: 'left'`,
  `{ right: width }` for `'right'`; the container gets `position: relative`). `onPointerDown` calls
  `setPointerCapture` and records start x + start width; `pointermove` applies
  `edge === 'left' ? start + dx : start - dx`, clamped to `[min, max]`, into **local** state only; `pointerup` /
  `lostpointercapture` releases and persists **once**.
- Accessibility/affordance, all cheap: the handle is `role="separator" aria-orientation="vertical"
aria-valuenow/min/max`, `tabIndex={0}`, ←/→ nudge by 8 px (32 with Shift) and persist, double-click resets to
  `defaultWidth`.

**`<ResizeHandle {...handleProps} />`** renders a 7 px-wide hit target with a 1 px visible line, `cursor: col-resize`,
highlighting on hover and while dragging.

**Wiring.** `App.tsx` `Studio()` (line 291-293) and `Floor.tsx` (`.floor-body`, line ~50 / `Inspector` at line 82)
each call the hook once, spread `trackStyle` on their grid container, and drop a `<ResizeHandle>` sibling.

**`styles.css`** — replace the two hard-coded tracks with the `var(--panel-w, …)` forms; add a generic
`.resize-handle` block; add `.resize-handle { display: none }` to the existing collapse media queries
(`@media (max-width: 860px)` at line 1007 for the rail, `@media (max-width: 980px)` at line 998 for the inspector),
since those already collapse to a single column.

## 4. The `view.panelSize` command

**`apps/desktop/src/main/commands/view.ts`** — a 14th definition beside `view.room` / `view.palette`:

```ts
export const viewPanelSize = define({
  id: 'view.panelSize',
  title: 'Resize a panel',
  description: 'Set the saved width of a resizable panel (studio.rail, floor.inspector).',
  mutating: false,
  props: {
    id: prop.string("the panel's save id, e.g. studio.rail"),
    width: prop.number('width in pixels', { min: 80, max: 1200 }),
  },
  run({ id, width }, ctx) { ctx.host.state.set(`panel.${id}.width`, width); … },
});
```

`prop.number` already supports `min`/`max` (`packages/commands/src/props.ts:53`, bounds enforced by `coerceProps`).
No new `UiEffect` variant is needed — the store's `session:changed` broadcast is what moves the rail.

**`commands/host.ts`** gains `state: SessionStore`. It is deliberately **not** called `session`: that name is already
`WorkspaceSession` on the same interface. The store module's doc comment calls out the distinction.
**`commands/index.ts`** registers `viewPanelSize`; `main/index.ts` passes `state: getSessionStore()` when building the
host. The existing `commands.test.ts` iterates the registry rather than asserting a count, so it needs no change —
but `pnpm build` must be re-run so `apps/desktop/dist/commands.json` picks the new command up (a test asserts the
catalog file matches the live registry).

The drag itself does **not** go through the command stack — it writes via `api.session.set`, so `commands.jsonl`
doesn't collect a provenance record per drag.

## 5. Ignore files & docs

- **`.gitignore`** — add `.vndesktop` (the only gitignore in the repo is at root; `*.tmp-*` already there covers the
  atomic-write temps).
- **`.prettierignore`** — add `.vndesktop` too. Prettier 3 does not read `.gitignore`, and `pnpm lint` runs
  `prettier --check .`, which would otherwise fail on the machine-written JSON.
- **`docs/desktopAppState.md`** — it currently documents every `App.tsx` state field as "Session only"; add the new
  persisted tier and its file location.
- **`docs/command-system.md`** + **`CLAUDE.md`** — bump "13 definitions" → 14, and add a short bullet under the
  desktop-runner section describing `.vndesktop/session.json`, the per-key merge contract, and `VN_DESKTOP_HOME`.

---

## Verification

1. **Gates:** `pnpm check`, `pnpm test`, `pnpm lint` all green (the new store tests run under
   `pnpm exec jest --selectProjects @vn/desktop`).
2. **Interactive:** `pnpm --filter @vn/desktop dev` → drag the STUDIO rail edge; switch to FLOOR and drag the
   inspector edge (opposite direction); confirm both track the cursor and clamp at min/max. Quit and relaunch —
   both widths come back with **no visible jump** from the defaults on first paint (the sync-snapshot check).
   Confirm `apps/desktop/.vndesktop/session.json` exists and `git status` does not show it.
3. **Keyboard/reset:** focus a handle, ←/→ nudges and persists; double-click restores the default.
4. **Multi-instance:** launch two builds against different CDP ports
   (`VN_CDP_PORT=9222 pnpm --filter @vn/desktop start` and `VN_CDP_PORT=9223 …` — the app takes no single-instance
   lock). Drag the rail in one and the inspector in the other, quit both, and confirm `session.json` holds **both**
   keys — that's the per-key merge doing its job. No `.lock` directory should remain.
5. **Command path:** `node scripts/vn-cdp.mjs "view.panelSize(id='studio.rail' width=300)"` moves the rail live in a
   running app; `node scripts/vn-cdp.mjs --catalog` lists `view.panelSize` with its `min`/`max` bounds; a rebuilt
   `apps/desktop/dist/commands.json` matches.
