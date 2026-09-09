/**
 * The one execution path for every command, whatever the caller. History is appended to
 * `vngen/state/commands.jsonl` alongside the pipeline's `tasks.jsonl`.
 */
import { app, dialog } from 'electron';
import { resolve as resolvePath } from 'node:path';
import { ProjectPaths } from '@vn/store';
import { openGit } from '@vn/git';
import { appendJsonl } from '@vn/util';
import { CommandStack, coerceProps, seqRanges } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import type { CommandHost } from '../commands/index.js';
import { desktopInteractions } from '../commands/interaction.js';
import type { AppContext } from './context.js';
import { getSession } from './sessionaccess.js';
import { createWindow } from './windowmanager.js';
import { scheduleApprovals, switchWorkspace } from './workspacelifecycle.js';
import { snapshotStore } from '../workspace/filecache.js';
import { UNDO_EXCLUDES } from '../workspace/workspace.js';
import { notify } from '../notify/notifications.js';
import { categoryOfCommand, shouldFileCommand } from '../../shared/notify.js';
import { workspaceIsTaken } from '../bootstrap/instancelock.js';
import type { ExecOutcome, UiEffect } from '../../shared/ipc.js';
import type { WindowId } from './windows.js';
import { liveDocs } from '../workspace/livedocs.js';

export function getStack(ctx: AppContext): CommandStack<CommandHost> {
  if (!ctx.stack) {
    const root = ctx.workspace();
    const paths = new ProjectPaths(root);
    const git = openGit(root);
    const host: CommandHost = {
      session                 : getSession(ctx),
      state                   : ctx.getSessionState(),
      // A `view.*` effect is targeted at the window whose palette or menu ran the command.
      // `windowFor` falls back to the focused window for the agent, CDP and main.
      ui: (effect: UiEffect, target?: WindowId) => ctx.sendTo(target, 'command:ui', effect),
      openWorkspace           : (next: string) => switchWorkspace(ctx, next),
      workspaceIsOpenElsewhere: async (next: string) => {
        const root = resolvePath(next);
        if (ctx.workspaceRoot && resolvePath(ctx.workspaceRoot) === root) return false;
        return workspaceIsTaken(root);
      },
      newWindow               : async (options) => createWindow(ctx, options),
      closeWindow: (target?: WindowId) => {
        const target_ = ctx.windowFor(target);
        if (!target_) return false;
        target_.close();
        return true;
      },
      quitApp                 : () => app.quit(),
      noteTurnWindow: (origin) => {
        ctx.turnWindow = origin;
      },
      windowCount             : () => ctx.windows.size,
      focusedWindow           : () => ctx.windows.focused() ?? 0,
      pickDirectory: async (options, target) => {
        const parent = ctx.windowFor(target);
        if (!parent) throw new Error('that window is gone');
        const result = await dialog.showOpenDialog(parent, {
          title      : options?.title ?? 'Open or create a VN project',
          buttonLabel: options?.buttonLabel ?? 'Open project',
          properties : ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      pickFiles: async (options, target) => {
        const parent = ctx.windowFor(target);
        if (!parent) throw new Error('that window is gone');
        const result = await dialog.showOpenDialog(parent, {
          title      : options?.title ?? 'Upload documents',
          buttonLabel: options?.buttonLabel ?? 'Upload',
          properties : options?.single ? ['openFile'] : ['openFile', 'multiSelections'],
          ...(options?.extensions
            ? { filters: [{ name: options.filterName ?? 'Files', extensions: options.extensions }] }
            : {}),
        });
        return result.canceled ? [] : result.filePaths;
      },
      saveFile: async (options, target) => {
        const parent = ctx.windowFor(target);
        if (!parent) throw new Error('that window is gone');
        const result = await dialog.showSaveDialog(parent, {
          title      : options?.title ?? 'Save a copy',
          buttonLabel: options?.buttonLabel ?? 'Save',
          ...(options?.defaultName ? { defaultPath: options.defaultName } : {}),
          ...(options?.extensions
            ? { filters: [{ name: options.filterName ?? 'Files', extensions: options.extensions }] }
            : {}),
        });
        return result.canceled ? undefined : result.filePath;
      },
      known: {
        command    : (id) => ctx.registry.get(id)?.props,
        interaction: (id) => desktopInteractions.get(id) !== undefined,
        coerce     : coerceProps,
      },
      // Lazily through `getStack`, not the local `stack`: the host is built while the stack is
      // still being constructed, so capturing it here would capture `undefined`.
      check                   : (id, props) => getStack(ctx).check(id, props),
    };
    ctx.stack = new CommandStack<CommandHost>({
      registry     : ctx.registry,
      context: {
        root,
        git,
        host,
        log    : (level, message) => ctx.broadcast('log', { level, message }),
        // TODO(desktop): route through the renderer once a confirm dialog exists; until then a
        // `confirm: true` command is reachable only from the UI's own affordances.
        confirm: () => Promise.resolve(true),
      },
      // Undo still works where commit-on-save refuses: a snapshot is held in memory and writes
      // nobody's history, so a project nested in a larger repo is snapshotted like any other.
      journal      : new UndoJournal({ root, store: snapshotStore, exclude: UNDO_EXCLUDES }),
      committer    : ctx.committer(),
      // A held-back run of edits that could not be committed is the one commit-on-save failure an
      // author has to act on, so it is filed durably rather than logged. The edits are on disk
      // and the stack keeps the batch, so the next flush retries.
      onCommitError: (error, records) => {
        void notify({
          category: 'error',
          level   : 'error',
          message: `${records.length} edit(s) (seq ${seqRanges(records.map((r) => r.seq))}) are saved but not committed: ${String(error)}`,
          source  : 'ui',
        });
      },
      onRecord: async (record) => {
        // The revision tells the renderer that files moved without it moving them. An undo or
        // redo always counts, as does a mutating command from the agent, CDP or main, whose
        // changes the renderer never invalidated. A `ui` command is left out because `exec`
        // already invalidated.
        if (record.stack || (record.mutating && record.source !== 'ui')) ctx.undoRevision++;
        // Before the log append, so a window is told a document moved as soon as the command
        // that moved it has finished writing rather than after the history behind it is durable.
        // The stamp is in place by the time `command:exec` reads it back, because this hook is
        // awaited inside the stack before the outcome is returned.
        ctx.noteWrites(record.written ?? []);
        await appendJsonl(paths.commandsLog, record);
        // Files every command's outcome, whoever ran it — the palette, a menu, the agent, CDP.
        // This one hook replaces a `say()` call at each of the thirty places that used to report
        // their own outcome. A refusal arrives as a throw, with `status: 'error'` and its reason.
        if (shouldFileCommand(record)) {
          await notify({
            category: record.status === 'ok' ? categoryOfCommand(record.id) : 'error',
            level   : record.status === 'ok' ? 'info' : 'error',
            message : record.status === 'ok' ? record.message : (record.error ?? record.message),
            source  : record.source === 'agent' || record.source === 'cdp' ? record.source : 'ui',
          });
        }
        // Scheduled rather than awaited: a recount reloads the project, and this hook sits on
        // the critical path of every command, including a one-line prose edit.
        // An undo restores files nobody edited through a command, so it counts as well.
        if (record.stack || record.mutating) scheduleApprovals(ctx);
        // Broadcast, because an undo is a fact about the worktree rather than an answer to one
        // window. Ctrl+Z in window B deliberately undoes an edit made in window A: undo restores
        // a snapshot of the whole worktree, so a per-window stack would misstate what it restores.
        ctx.broadcast('command:ui', {
          type    : 'undo',
          state   : getStack(ctx).undoState(),
          revision: ctx.undoRevision,
        });
      },
    });
  }
  return ctx.stack;
}

/**
 * Tell the caller which version each document its command wrote now carries, so it can recognize
 * the echo of its own write. The versions are read rather than stamped: `onRecord` stamped them
 * and broadcast them already, and stamping again would hand the caller a version no window heard.
 */
export function withVersions(outcome: ExecOutcome): ExecOutcome {
  const written = outcome.record?.written ?? [];
  return written.length === 0 ? outcome : { ...outcome, versions: liveDocs.current(written) };
}
