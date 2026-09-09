/**
 * A real `CommandStack` over a real project, so a command's `affects` can be checked against what
 * it actually wrote rather than against what it claims.
 *
 * `__fixtures__` rather than a `.harness.ts` name because `eslint.config.mjs` turns
 * `boundaries/element-types` off for `**\/*.test.ts` and `**\/__fixtures__/**` and nowhere else,
 * and this reaches `@vn/testkit`.
 *
 * The workspace is captured into this module's own `ContentStore` either side of every command,
 * so the diff covers all 94 mutators rather than only the 62 the undo journal brackets.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { ContentStore, diffTrees } from '@vn/commands/snapshot';
import { CommandStack, coerceProps, type CommandRecord } from '@vn/commands';
import type { TestProject } from '@vn/testkit';
import type { UiEffect } from '../../../../shared/ipc.js';
import { SessionStore } from '../../../workspace/sessionstore.js';
import { SessionState } from '../../../workspace/sessionstate.js';
import { WorkspaceSession, type SessionDeps } from '../../../session.js';
import { createDesktopRegistry } from '../../index.js';
import { desktopInteractions } from '../../interaction.js';
import type { CommandHost } from '../../host.js';

/**
 * The two paths the capture leaves out, each for its own reason.
 *
 * `keys` holds credentials, and a capture would read one into an in-memory blob store; the repo's
 * secrets convention says no. `.vnstudio/session.json` is written by a debounced flush, so a write
 * from one command lands during the next command's window and would be reported against the wrong
 * one. The cost is a blind spot: `view.saveLayout`'s session write is declared and checked by the
 * registry rules but never measured here.
 */
export const SKIPPED = new Set(['keys', '.vnstudio/session.json']);

/** The three permission doors answer as an abandoned window would: no plan, no answers, no consent. */
const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

/** What one command did: whether it ran, what the workspace diff found, and what it claimed. */
export interface RunResult {
  ok: boolean;
  error?: string;
  /** Paths whose contents moved between the two captures, root-relative and forward-slashed. */
  diff: string[];
  /** `CommandOutput.written`, as the command reported it. */
  written: string[];
  /** `CommandOutput.data`, for a fixture that has to name what the previous command created. */
  data?: unknown;
}

export interface AffectsHarness {
  root: string;
  session: WorkspaceSession;
  /** Every `UiEffect` a command pushed, in order. */
  effects: UiEffect[];
  run(id: string, props: Record<string, unknown>): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** Every host member a command may reach that this harness does not answer for real. */
function unavailable(member: string): never {
  throw new Error(`the affects harness has no ${member}`);
}

/**
 * Open a stack over `project`. The session is built with `mock: true`, so `story.decomposeAll`,
 * `prompt.condense` and `gengraph.run` refuse a model call rather than attempting one, and the
 * stack is given neither a journal nor a committer, so nothing writes `.git` or `commands.jsonl`.
 */
export async function openAffectsHarness(project: TestProject): Promise<AffectsHarness> {
  const root = project.dir;
  const session = new WorkspaceSession(root, true, deps);
  const registry = createDesktopRegistry();
  const effects: UiEffect[] = [];

  // Outside the workspace: the install-global session file is written eagerly, and one inside the
  // project would land in the diff of whichever command happened to be running.
  const installDir = await fs.mkdtemp(join(tmpdir(), 'vn-affects-'));
  const install = await SessionStore.open(installDir);
  const state = new SessionState(install);
  await state.openProject(root);

  const host: CommandHost = {
    session,
    state,
    ui                      : (effect) => void effects.push(effect),
    openWorkspace           : () => unavailable('openWorkspace'),
    workspaceIsOpenElsewhere: () => Promise.resolve(false),
    pickDirectory           : () => unavailable('directory chooser'),
    pickFiles               : () => unavailable('file chooser'),
    saveFile                : () => unavailable('save-as chooser'),
    newWindow               : () => unavailable('newWindow'),
    closeWindow             : () => unavailable('closeWindow'),
    quitApp                 : () => unavailable('quitApp'),
    windowCount             : () => 1,
    noteTurnWindow          : () => {},
    // Both `view.*` mutators ask, to decide which window's remembered template they write.
    focusedWindow           : () => 0,
    known: {
      command    : (id) => registry.get(id)?.props,
      interaction: (id) => desktopInteractions.get(id) !== undefined,
      coerce     : coerceProps,
    },
    check                   : (id, props) => stack.check(id, props),
  };

  const records: CommandRecord[] = [];
  const stack = new CommandStack<CommandHost>({
    registry,
    context: {
      root,
      git: openGit(root),
      host,
      log    : () => {},
      // Six of the runnable commands are `confirm: true`, and `exec` refuses outright rather than
      // assuming consent when no gate is wired.
      confirm: () => Promise.resolve(true),
    },
    onRecord: (record) => void records.push(record),
  });

  const store = new ContentStore();

  return {
    root,
    session,
    effects,
    async run(id, props) {
      const before = await store.capture(root, SKIPPED);
      const seq = records.length;
      const outcome = await stack.exec(id, props, 'cdp');
      const after = await store.capture(root, SKIPPED);
      return {
        ok: outcome.ok,
        ...(outcome.ok ? {} : { error: outcome.error }),
        diff   : diffTrees(store, before, after),
        written: records.slice(seq).flatMap((record) => record.written ?? []),
        ...(outcome.ok && outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    },
    async dispose() {
      await stack.dispose();
      await state.closeProject();
      await fs.rm(installDir, { recursive: true, force: true });
    },
  };
}
