import type { WorkspaceSession } from '../session.js';
import type { SessionAccess } from '../sessionstate.js';
import type { UiEffect } from '../../shared/ipc.js';
import type { WindowId } from '../windows.js';

/** Presentation of a file chooser. Everything is optional; the defaults are the document upload. */
export interface FilePickOptions {
  title?: string;
  buttonLabel?: string;
  /** Extensions offered, without dots. Absent means every file. */
  extensions?: string[];
  /** What that filter is called in the dialog's dropdown. */
  filterName?: string;
  /** One file rather than many — a chooser that fills a single slot. */
  single?: boolean;
}

/**
 * Presentation of a directory chooser. The defaults are worded for opening a project, so a
 * chooser that only browses for a folder overrides them.
 */
export interface DirectoryPickOptions {
  title?: string;
  buttonLabel?: string;
}

/**
 * What the desktop's commands are allowed to reach. Everything else a command needs — the
 * workspace root, git, logging, the confirmation gate — comes from `CommandContext`.
 */
export interface CommandHost {
  session: WorkspaceSession;
  /**
   * Persisted UI state, routed to the project's file or the install's by key. Named `state` to
   * keep it distinct from the `session` field.
   */
  state: SessionAccess;
  /**
   * Push a UI change to a renderer over the `command:ui` event channel.
   *
   * `target` is the window that asked — `ctx.origin` at every call site, because a `view.*`
   * effect applies to the window whose palette or menu ran the command. An omitted target (or one
   * naming a window that has since closed) falls back to the focused window, which is what the
   * agent, CDP and main itself get.
   */
  ui(effect: UiEffect, target?: WindowId): void;
  /**
   * Open a different project: bootstrap it if it is not one yet, then rebuild everything that
   * was bound to the old root. `host.session` is stale the moment this resolves, which is why
   * it lives here and not on the session.
   */
  openWorkspace(root: string): Promise<{ root: string; title: string }>;
  /**
   * Does another app instance already have `root` open? One instance per workspace is the rule
   * (`../instancelock.ts`), so opening a project twice is a refusal rather than a second copy.
   * The answer describes this instant only; `openWorkspace` re-acquires for real and refuses again.
   */
  workspaceIsOpenElsewhere(root: string): Promise<boolean>;
  /** The native directory chooser. `undefined` when the user cancelled; throws with no window. */
  pickDirectory(options?: DirectoryPickOptions, target?: WindowId): Promise<string | undefined>;
  /** The native file chooser. Empty when the user cancelled; throws with no window. */
  pickFiles(options?: FilePickOptions, target?: WindowId): Promise<string[]>;
  /** Open a new window, optionally on an editor and subject. Answers its index. */
  newWindow(options?: { editor?: string; subject?: string }): Promise<WindowId>;
  /** Close one window — the origin when none is named. Answers whether there was one to close. */
  closeWindow(target?: WindowId): boolean;
  /** Quit the app, closing every window. Each still gets its unsaved-changes guard. */
  quitApp(): void;
  /** How many windows are open, so `window.close` can say what closing the last one does. */
  windowCount(): number;
  /**
   * Remember which window started the agent turn about to run, so the plan, ask and confirm
   * cards land on it rather than on whichever window happens to hold focus when they go out.
   * `agent.run` calls this with `ctx.origin` — `undefined` for the palette-less callers (CDP,
   * main itself), which main answers with the focused window as it does any unaddressed push.
   */
  noteTurnWindow(origin: WindowId | undefined): void;
  /**
   * Which window an unaddressed effect would land in. A command run by the agent or by CDP has
   * no `ctx.origin`, and per-window state has to be recorded against the same window the effect
   * reaches — otherwise `view.applyLayout` rearranges window 3 and writes window 0's template key.
   */
  focusedWindow(): number;
  /**
   * Ask another command's precondition — the stack's own `check`, reached through the host
   * because a command cannot import the stack that runs it.
   */
  check(
    id: string,
    props: Record<string, unknown>,
  ): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>;
}
