# Onboarding editor, a shorter add-editor menu, and user-level API keys

Three things that only look separate. A first-run onboarding pane is an editor nobody should
find in the pane switcher — it is reached once, from a menu — which forces path.ux to grow a
way to say _this area is not on offer_. And what the onboarding pane exists to collect is an
API key, which today can only be written into a project's `keys/`, so a second project starts
from nothing. The key moves up a level; the pane that writes it is reachable from File; and
the pane switcher stops listing it.

Packaging, code signing, the update check and the CI docs audit are **out of scope** — this is
the slice they will need in place first.

## 1. Where user-level state lives

### The recommendation: platform-native, `~/.vnauthor` honoured as a fallback

Use the platform's own configuration directory, resolved by one function:

| Platform | Directory                                                         |
| -------- | ----------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\vnauthor` (`C:\Users\<u>\AppData\Local\vnauthor`)  |
| macOS    | `~/Library/Application Support/vnauthor`                          |
| Linux    | `$XDG_CONFIG_HOME/vnauthor`, else `~/.config/vnauthor`            |

Four reasons this beats a flat `~/.vnauthor` everywhere:

- **The desktop app already lives there.** Electron's `app.getPath('userData')` resolves under
  `%LOCALAPPDATA%` / `Application Support` on its own. Putting our directory beside it means
  the app and the CLI agree on one place without the app overriding its own defaults.
- **An installer and an uninstaller can find it.** A packaged app that wants to offer "remove
  my settings too" has a directory it can name; a dotfile in the user profile is something
  every Windows uninstaller convention says is not ours to touch.
- **Local, deliberately, not Roaming.** `%APPDATA%` roams to domain controllers and to other
  machines. An API key is exactly what should not be copied off the machine it was pasted on.
- **`~/.vnauthor` on Windows is a dotfile in a directory nothing else uses for config**, which
  makes "where is my key" a worse support question than it needs to be.

The cost is one function, and we pay it once. Against that, keep two escape hatches:

- **`$VNAUTHOR_HOME` overrides the whole thing.** Tests set it, CI sets it, and a user who
  wants their config on a stick can set it. This is what keeps the platform branch from being
  untestable.
- **`~/.vnauthor` is still _read_** when the native directory does not exist, so anything
  written by hand before this lands keeps working and nothing has to be migrated. It is never
  written to.

### Key precedence

Unchanged at the top, one entry appended at the bottom:

1. The environment variable named in `project.yaml` (`config.keys.<vendor>`).
2. The project's own `keys/`.
3. The enclosing repo/workspace root's `keys/`.
4. **`<user config dir>/keys/`** — new.

So a project that carries a key still wins, exactly as asked; a project that carries none falls
through to the one the author set up once.

### The changes

**`packages/config/src/keys.ts`** — the whole seam is `secretDirsFor`, which is why this is
small:

- `userConfigDir(): string` — the table above, `$VNAUTHOR_HOME` first, then the legacy
  `~/.vnauthor` if it exists and the native directory does not. Pure but for `process.env` and
  `os.homedir()`, both injectable for the test.
- `userKeysDir(): string` — `join(userConfigDir(), 'keys')`.
- `secretDirsFor(projectDir, opts?: { includeUser?: boolean })` appends `userKeysDir()` last.
  **Default `true`**, so every host gets it without a change and no host can forget it.

**The one hazard, and how it is closed.** With the default on, a test that resolves keys would
read the developer's real key off their own machine and pass for the wrong reason — or fail on
CI, where there is none. Two guards, both required:

- `@vn/testkit`'s `record.ts` passes `{ includeUser: false }` explicitly. A test project is a
  closed world; that is the whole point of testkit.
- The jest setup sets `VNAUTHOR_HOME` to a scratch directory, so anything that forgets still
  reads an empty one rather than the author's.

**`project.setKey`** grows a `scope` prop — `project` (default, today's behaviour) or `user`
(writes `<user config dir>/keys/<file>`). The user scope needs no gitignore work, because the
directory is not in a repository; it does need `chmod 600` on POSIX, which is the one thing a
`keys/` inside a project never needed. It stays **not undoable** for the reason already
written down: an undo point is a git snapshot, and this file is not in git.

**`project.keyStatus`** (new, read-only) — for each vendor, whether a key resolved and _which
source_ answered: env var name, project dir, root dir, or user dir. Never the value. The
onboarding editor is built on this, and it is also the honest answer to "why is it still asking
me" when a stale environment variable is shadowing a freshly pasted file.

## 2. Limiting the add-editor dropdown (path.ux)

path.ux enumerates `areaclasses` in `makeAreasEnum()` and skips only `AreaFlags.HIDDEN` — a
**static, per-class** flag. That is the right shape for chrome (the header bar) and the wrong
shape for everything else we want to control: which editors an application offers is the
application's policy, it can differ per build, and path.ux should not have to know why.

### The addition

In `scripts/screen/area_base.ts`:

```ts
/** Whether an area is offered in the pane switcher and the docker's add menu. */
export type AreaMenuFilter = (areaname: string, def: IAreaDef) => boolean;

/** Install an application-wide filter. Passing `undefined` restores "offer everything". */
export function setAreaMenuFilter(filter?: AreaMenuFilter): void;

export function makeAreasEnum(filter?: AreaMenuFilter): EnumProperty;
```

- `makeAreasEnum` applies `AreaFlags.HIDDEN` first, then the filter. An explicit argument wins
  over the installed one, so a caller with its own policy is not fighting a global.
- `AreaDocker` (its `makeAreasEnum()` call around line 375) and `ScreenArea.makeAreasEnum()`
  pass nothing and pick up the installed filter. Every existing caller keeps working.
- **The filter narrows a menu; it does not unregister anything.** `switchEditor(cls)` with a
  filtered class still works, and a stored layout naming one still restores — which is exactly
  what the onboarding editor needs, since a menu entry opens it by name.

Tests in path.ux: an area filtered out is absent from the enum, still constructible by name,
and a filter that excludes everything yields an empty enum rather than throwing.

This is a submodule change, so it lands as its own commit in `vendor/path.ux` and the
superproject's pinned sha moves in the same commit as the app-side change that needs it.

### The app side

`src/shared/editors.ts` gains one optional field per entry:

```ts
/** Absent means offered. `false` means reachable only by name — from a menu, the palette,
 *  the agent or a stored layout — and never listed in the pane switcher. */
offered?: false;
```

and one export, `OFFERED_EDITOR_IDS`. The shell installs
`setAreaMenuFilter((name) => OFFERED.has(name))` at boot, and the header's View ▸ Editors
submenu is built from the same list — so the two ways of switching a pane say the same thing,
which is the rule that already governs the tab tooltip.

`editorNameProblems` is unchanged: an unoffered editor is still _named_, so the boot check
still catches it going missing.

## 3. The onboarding editor

A thirteenth editor, `id: 'onboarding'`, `title: 'Setup'`, `offered: false`, claiming nothing —
no document-tree node opens it, which is why it has no `claims`.

What it shows, per vendor (`KEY_VENDORS` already orders them, so the pane invents no list):

- Whether a key resolved, and from where, out of `project.keyStatus`.
- Numbered steps, rendered from **one markdown file** rather than typed into the pane, so the
  same source is what a future CI audit checks and what a docs page or PDF would be generated
  from. `docs/api-keys.md`, shipped as a build resource.
- An **Open console** button per vendor, launching the vendor's key page in the system browser.
- A paste box wired to `project.setKey`, with a **scope** choice — this project, or every
  project. Default: every project, because that is the answer that is right the second time.
- A **Test key** button making one cheap real call and reporting pass or fail. Without it the
  author leaves the pane not knowing, which is the state the pane exists to end.
- The money sentence, plainly: both vendors need billing set up, Gemini has a free tier and
  Claude does not. Neither vendor's own key page says it, and it is what people get stuck on.

Every control carries a tooltip, and a disabled one shows its command's refusal verbatim.

### Reaching it

A **File menu** entry — the `VN STUDIO` menu in `renderer/pathux/editors/header.ts`, not
View ▸ Editors, which lists panes rather than acts:

```
Set Up API Keys…   →   view.open(editor='onboarding' where='elsewhere')
```

`where='elsewhere'` already means "the biggest pane that is not the active one, splitting only
if there is no other", so the pane arithmetic needed for this exists and the plan adds none.

**This is an interim arrangement.** [`multiple-windows.md`](../multiple-windows.md) is in progress;
when it lands, the onboarding editor should open as **its own window** instead of taking over
a pane of the author's layout — a first-run walkthrough that eats the biggest pane is a
walkthrough that rearranges the screen to say hello. Recorded in `CLAUDE.md` so it is not
rediscovered.

### First run

If no key resolves for either vendor when a workspace opens, file a notification offering the
pane rather than opening it. A window that rearranges itself before the author has done
anything is worse than a line in the menu bar they can ignore.

## 4. Documentation

- **`docs/api-keys.md`** — new, and the single source for the walkthrough text. Listed in
  `docs/index.md`.
- **`docs/desktop-app.md`** — the thirteenth editor, `offered: false`, and the File-menu entry.
- **`docs/cli.md`** — key resolution now has a fourth rung.
- **`CLAUDE.md`** — three additions:
  - Under conventions: **user-level state lives in one directory, and it is not in a repo** —
    the platform table, `$VNAUTHOR_HOME`, the legacy `~/.vnauthor` read, and the standing rule
    that **any future settings system writes there too**, so settings and keys never end up in
    two homes.
  - Beside the key policy: the four-rung precedence, and that a project's own key wins.
  - Beside the editor list: `offered: false` means named but not listed, path.ux's
    `setAreaMenuFilter` is what enforces it, and the note that the onboarding editor becomes
    its own window once multi-window lands.

## 5. Order of work

1. path.ux: `setAreaMenuFilter` + `makeAreasEnum(filter?)`, with tests. Submodule commit.
2. `@vn/config`: `userConfigDir`/`userKeysDir`, `secretDirsFor` opt-out, testkit + jest guards.
3. `project.setKey` scope prop, `project.keyStatus`.
4. `offered?: false` in `EDITORS`, the shell's filter install, the View submenu narrowing.
5. `docs/api-keys.md`, then the onboarding editor rendering it.
6. The File menu entry, and the first-run notification.
7. Docs, including the three `CLAUDE.md` additions.

Each step is green on its own — `pnpm check`, `pnpm test`, `pnpm lint` — because 1–4 are
additive and 5–6 are the first thing to use them.
