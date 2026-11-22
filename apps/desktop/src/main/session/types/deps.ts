import type { AgentEvent, AskQuestion, Plan, PlanDecision } from '@vn/authoring';
import type { PropValue } from '@vn/commands';
import type { BusyProgress } from '../../../shared/ipc.js';
import type { Tour } from '../../../shared/tours.js';

/** Hooks the session uses to reach the renderer: events out, and the three permission doors. */
export interface SessionDeps {
  emitEvent(event: AgentEvent): void;
  /**
   * One event of the analyst's turn. A separate door from {@link emitEvent} because a debug
   * conversation is about the authoring agent rather than part of it, and putting it on the same
   * channel would record it into the very thread being analysed.
   */
  emitReport(event: AgentEvent): void;
  requestPlan(plan: Plan): Promise<PlanDecision>;
  /**
   * The author's answers to a form, one per question and in its order. An empty string is a
   * deliberate answer and is passed through as-is, not treated as a skip. A question's `choices`
   * is a shortlist the card offers to click; the answer comes back as a string either way.
   */
  requestAnswer(questions: readonly AskQuestion[]): Promise<string[]>;
  /** Yes or no to an always-confirm tool. `detail` is the English sentence the card reads out. */
  requestConfirm(tool: string, detail: string): Promise<boolean>;
  /** The app build, so a bug report names the code a maintainer should read. Absent in tests. */
  appVersion?: string;
  /**
   * Where the app may keep files that belong to the app rather than the author — a drafted bug
   * report, cached provider docs. Deliberately not under the project, so neither ends up in the
   * project's git history.
   */
  userData?: string;
  /**
   * Hand a URL to the OS, and put text on the clipboard. Both come from Electron, so they arrive
   * as injected functions rather than imports — this file is typechecked and tested with no app
   * around it. When they are absent there is no browser, and `report.openIssue` reports that
   * rather than claiming success.
   */
  openExternal?(url: string): Promise<void>;
  writeClipboard?(text: string): void;
  /**
   * Tell the window what long-running work is in flight. Not routed through the command host:
   * the effect is pushed while a command is still running, which is when that host has not
   * returned an outcome to attach anything to.
   */
  pushBusy(state: { what?: string } & BusyProgress): void;
  /**
   * Offer to diagnose the call that just failed. Pushed for the same reason `pushBusy` is: the
   * author is answering a card that is still open inside a running turn, and there is no command
   * outcome to hang it on.
   */
  offerDiagnosis?(fault: { thread?: string; message: string }): void;
  /**
   * Walk the author through a tour the agent wrote. Pushed for the same reason {@link pushBusy}
   * is: the agent is still mid-turn and there is no command outcome to hang an effect on. Absent
   * where there is no window, and `show_me` then refuses rather than claim it showed anything.
   */
  showTour?(tour: Tour): void;
  /**
   * The stack's verdict for one invocation, for the agent's `ux_check`. The session does not hold
   * the stack, so the host wires it the way {@link showTour} is wired. Absent where there is no
   * stack, and the tool is then not registered, so `vnauthor` never lists it.
   */
  checkCommand?(
    id: string,
    props: Record<string, PropValue>,
  ): Promise<{ state: 'accept' | 'refuse' | 'undeclared'; message: string }>;
}
