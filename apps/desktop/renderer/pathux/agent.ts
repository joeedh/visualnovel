/**
 * The live conversation: one store, subscribed once at boot, reduced by the pure functions in
 * `convo.ts`.
 *
 * It is a module rather than editor state because the agent streams whether or not a convo pane
 * is open, and a pane opened later has to show what was already said. A pane notices a change by
 * comparing a revision counter, since `update()` runs every frame and there is nothing to
 * subscribe to.
 */
import { api, isLive, onAgentEvent } from '../api.js';
import { exec, noteBinding, onExec, shell } from './bridge.js';
import { startForm, type AskForm } from '../rules/askform.js';
import {
  answered,
  answeredQuestion,
  asked,
  cleared,
  confirmAsked,
  confirmDecided,
  decided,
  emptyConvo,
  offered,
  proposed,
  queried,
  received,
  replayed,
  type Convo,
  type ThreadRecord,
} from '../../src/shared/convo.js';
import type { AskRequest, ConfirmRequest, PlanRequest } from '../../src/shared/ipc.js';
import type { OpenedThread } from '../../src/shared/threads.js';

const OPENING = isLive
  ? 'Workspace loaded. Tell me what to change — I plan first, you approve, then I edit and commit.'
  : 'Design preview (no Electron bridge). Live data appears when launched as the desktop app.';

/**
 * What a reopened thread says in the dialogue box. It stays on screen after the replayed turns are
 * scrolled away, because an author types at the bottom of the pane and would otherwise address a
 * model that was never shown this conversation.
 */
const REOPENED = 'Reopened for reading — the agent has not been shown this conversation.';

/** What a continued thread says in the same place, once the agent has been given its history. */
const RESUMED = 'Continued — the agent has been shown everything above.';

let state: Convo = emptyConvo(OPENING);
let rev = 0;
/** Text waiting for a composer: written by a surface, taken by the pane once. */
let seeded: string | null = null;
/**
 * What the author has picked and typed into the question now on screen. It sits beside the question
 * rather than inside a pane, so two convo panes fill in one form and a pane re-created by a layout
 * change keeps what was answered before it. A pane holding its own copy would send the picks it
 * happened to see, which is how a picked answer reaches the agent as no answer at all.
 */
let form: AskForm | null = null;
/**
 * The thread being read, while one is on screen. Held so the Convo pane can offer to continue it and
 * grey that offer with the sentence the command would refuse with, without reading the log again on
 * every frame.
 */
let reading: OpenedThread | null = null;

export function convo(): Convo {
  return state;
}

/** The conversation on screen for reading, or `null` when the live one is. */
export function reopenedThread(): OpenedThread | null {
  return reading;
}

/** Bumped by anything that changes the conversation, including a seed. */
export function revision(): number {
  return rev;
}

function set(next: Convo): void {
  state = next;
  rev++;
}

/**
 * Send one turn. Through `agent.run` rather than the `agent:run` channel the React shell used,
 * so a turn the author types and a turn the palette runs are the same command with the same
 * provenance.
 *
 * The selected scene rides along as a prop, so the provenance record holds what the author was
 * looking at beside what they asked. Main resolves it against the project and drops it if it no
 * longer names anything.
 */
export async function ask(text: string): Promise<void> {
  const input = text.trim();
  if (!input || state.busy) return;
  // A turn opens a thread of its own, so what is on screen stops being the saved one and the offer
  // to continue it goes away.
  reading = null;
  set(asked(state, input));
  const outcome = await exec('agent.run', { input, scene: shell().ui.sceneId });
  set(answered(state, outcome.ok ? outcome.record.message : null));
}

/**
 * Answer the plan card. `plan:decision` is not a command — it is the reply to a request main is
 * already blocked on, and the agent's own permission gate owns what it means.
 */
export async function decide(approved: boolean): Promise<void> {
  const request = state.plan;
  if (!request) return;
  set(decided(state, { approved }));
  void api.invoke('plan:decision', { id: request.id, decision: { approved } });
  // Approving switches into execute mode. The agent reports the change too, but the badge
  // should not lag the click that caused it.
  if (approved) setMode('execute');
}

/** The form for this request, started on arrival and kept until the answers go back. */
export function askFormFor(request: AskRequest): AskForm {
  if (!form || form.questions !== request.questions) form = startForm(request.questions);
  return form;
}

/** The form as it stands, which is not the one a cached card was drawn from. */
export function askFormNow(): AskForm | null {
  return form;
}

/**
 * Replace the form. A keystroke passes `redraw` false, because redrawing the card would take the
 * caret out of the box it was typed into; every other transition bumps the revision so a second
 * pane on the same question follows.
 */
export function setAskForm(next: AskForm, redraw = true): void {
  form = next;
  if (redraw) rev++;
}

/**
 * Answer the question card — one answer per question of the form, in its order. Like `decide`,
 * this is a reply rather than a command: main is parked inside the agent's turn, so nothing here
 * is undoable and there is no provenance to record. The empty string is passed through as a
 * deliberate "nothing to add", and a short array is padded with it so the turn always resumes.
 */
export function answer(answers: string[]): void {
  const request = state.question;
  if (!request) return;
  form = null;
  const trimmed = request.questions.map((_, i) => (answers[i] ?? '').trim());
  set(answeredQuestion(state, trimmed));
  void api.invoke('ask:answer', { id: request.id, answers: trimmed });
}

/** Answer the confirm card. A denial is a refusal the tool reports; nothing else happens. */
export function allow(allowed: boolean): void {
  const request = state.confirm;
  if (!request) return;
  set(confirmDecided(state, allowed));
  void api.invoke('confirm:decision', { id: request.id, allowed });
}

function setMode(mode: 'plan' | 'execute'): void {
  shell().ui.agentMode = mode;
  shell().api.notifyChange();
}

/**
 * Drop a targeted opener into the composer, so the next turn is scoped to what was clicked. The
 * pane focuses the field around it. When no pane is open to take the seed, it becomes the text
 * the composer holds once one does open.
 */
export function seed(text: string): void {
  seeded = text;
  rev++;
}

/** Take the pending seed, if there is one. Reading it consumes it. */
export function takeSeed(): string | null {
  const text = seeded;
  seeded = null;
  return text;
}

/**
 * Put a surface's opener in the composer, on a conversation of its own. A conversation already on
 * screen is saved and closed first, through `agent.newThread` rather than by clearing here, so the
 * transcript is filed the same way it is when the author starts one from the menu. An empty one is
 * reused instead, since closing it would file a conversation nobody had.
 *
 * The decision is made here rather than in the command because this is the side that can see it.
 * Main's own copy of the conversation is empty while a thread is on screen for reading, and full
 * once one has been continued, so only the screen answers for both.
 */
async function openerFor(text: string): Promise<void> {
  if (state.feed.length > 0 && !(await exec('agent.newThread')).ok) return;
  seed(text);
}

/** Subscribe to the agent's stream and its three permission doors. Called once, at boot. */
export function installAgent(): void {
  onAgentEvent((event) => set(received(state, event)));
  api.on('permission:plan', (request: PlanRequest) => set(proposed(state, request)));
  api.on('permission:ask', (request: AskRequest) => set(queried(state, request)));
  api.on('permission:confirm', (request: ConfirmRequest) => set(confirmAsked(state, request)));

  // Clearing and the thread commands follow the command rather than the pane's button, so the
  // palette running the same id has the same effect. `window.vn`/CDP goes straight to main and
  // reaches neither, and none of these commands emits an event.
  onExec((id, outcome) => {
    if (!outcome.ok) return;
    if (id === 'agent.clear') {
      reading = null;
      set(cleared(state, 'Conversation cleared. Back to plan mode.'));
      setMode('plan');
    } else if (id === 'agent.newThread') {
      reading = null;
      set(cleared(state, 'New conversation. Tell me what to change.'));
      setMode('plan');
    } else if (id === 'agent.openThread') {
      const record = outcome.data as OpenedThread | undefined;
      if (record) {
        reading = record;
        set(replayed(state, record.items, REOPENED));
        // Main has already rebound the agent to this conversation's model. The bar is told
        // directly, because no effect reports a model change.
        noteBinding(record.model, record.effort);
      }
      setMode('plan');
    } else if (id === 'agent.resumeThread') {
      const record = outcome.data as ThreadRecord | undefined;
      // The same replay, on a live conversation. The binding is left alone: continuing happens on
      // the model bound now, which is what main checked the stored history against.
      reading = null;
      if (record) set(replayed(state, record.items, RESUMED));
      setMode('plan');
    } else if (id === 'upload.files' || id === 'upload.pick') {
      // The seeded turn is the command's sentence rather than the model's, so the conversation
      // opens on the author's question. `seed` is present only when bytes landed, so a cancelled
      // dialog and an upload whose files were all refused both leave the conversation alone.
      const upload = outcome.data as { seed?: string; suggestions?: string[] } | undefined;
      if (!upload?.seed) return;
      set(offered(state, upload.seed, upload.suggestions ?? []));
      setMode('plan');
    } else if (id === 'agent.editLine' || id === 'agent.fixAsset') {
      // These two ask about something on screen rather than about the project, so the opener is
      // the composer's text and not a line the agent said. The pane the command opened focuses
      // the field around it.
      const opener = (outcome.data as { seed?: string } | undefined)?.seed;
      if (opener) void openerFor(opener);
    }
  });
}
