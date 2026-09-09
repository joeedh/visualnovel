/**
 * The `WorkspaceSession` singleton, the install-global session store, and the `SessionDeps` that
 * wire the two of them (plus the rest of `AppContext`) into the session's own callbacks.
 */
import { app, clipboard, shell } from 'electron';
import { DEFAULT_BUDGET, type BudgetChoice } from '@vn/types';
import { BUDGET_KEY } from '../commands/agent.js';
import type { AppContext } from './context.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';
import { SessionStore } from '../workspace/sessionstore.js';
import { SessionState } from '../workspace/sessionstate.js';
import { MOCK } from '../bootstrap/cliargs.js';
import type { AskRequest, ConfirmRequest, PlanRequest, SessionValue } from '../../shared/ipc.js';

function buildDeps(ctx: AppContext): SessionDeps {
  return {
    emitEvent: (event) => {
      // An agent tool call is not a command and never reaches the stack, so its writes are
      // stamped here instead. Before the event goes out, so a pane cannot be told a tool ran
      // and then be told separately what it wrote.
      if (event.type === 'tool') ctx.noteWrites(event.result.written ?? []);
      ctx.broadcast('agent:event', event);
    },
    emitReport    : (event) => ctx.broadcast('report:event', event),
    requestPlan: (plan) =>
      ctx.askWindow(ctx.pendingPlans, (id, target) => {
        const request: PlanRequest = { id, plan };
        target.webContents.send('permission:plan', request);
      }),
    requestAnswer: (questions) =>
      ctx.askWindow(ctx.pendingAsks, (id, target) => {
        const request: AskRequest = { id, questions: [...questions] };
        target.webContents.send('permission:ask', request);
      }),
    requestConfirm: (tool, detail) =>
      ctx.askWindow(ctx.pendingConfirms, (id, target) => {
        const request: ConfirmRequest = { id, tool, detail };
        target.webContents.send('permission:confirm', request);
      }),
    // A getter, not a value: the development build appends the commit, and that costs a `git`
    // call, which is not something a module-level object literal should be waiting on.
    get appVersion() {
      return ctx.appVersion;
    },
    userData      : app.getPath('userData'),
    openExternal  : (url) => shell.openExternal(url),
    writeClipboard: (text) => clipboard.writeText(text),
    pushBusy      : (state) => ctx.broadcast('command:ui', { type: 'busy', ...state }),
    offerDiagnosis: (fault) =>
      ctx.broadcast('command:ui', { type: 'agent', action: 'diagnose', ...fault }),
    showTour: (tour) =>
      ctx.broadcast('command:ui', {
        type  : 'tour',
        action: 'start',
        tour  : '',
        steps : JSON.stringify(tour),
      }),
  };
}

export function getSession(ctx: AppContext): WorkspaceSession {
  if (!ctx.session) {
    ctx.session = new WorkspaceSession(ctx.workspace(), MOCK, buildDeps(ctx));
    // The one agent setting that outlives the run: what a turn may spend is a decision about
    // this machine's bill, so it is restored here rather than re-chosen every launch.
    ctx.session.budget = ctx.getSessionState().get<BudgetChoice>(BUDGET_KEY, DEFAULT_BUDGET);
  }
  return ctx.session;
}

/**
 * Open the install-global store and the router over it. The project's own store is opened
 * separately, once the workspace root is known.
 *
 * Every write broadcasts, whoever made it and whichever file it lands in.
 */
export async function openSessionStore(ctx: AppContext): Promise<void> {
  const notify = (key: string, value: SessionValue): void => {
    ctx.broadcast('session:changed', { key, value });
  };
  ctx.sessionState = new SessionState(await SessionStore.open(undefined, notify), notify);
}
