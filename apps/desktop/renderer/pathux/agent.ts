/**
 * The live conversation: one store, subscribed once at boot, reduced by the pure functions in
 * `convo.ts`.
 *
 * It is a module rather than editor state for the reason every other push in this shell is:
 * the agent streams whether or not a convo pane is open, and a pane opened later has to show
 * what was already said. A revision counter is all a pane needs to notice — `update()` runs
 * every frame, so there is nothing to subscribe to.
 */
import { api, isLive, onAgentEvent } from '../api.js';
import { exec, onExec, shell } from './bridge.js';
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

const OPENING = isLive
  ? 'Workspace loaded. Tell me what to change — I plan first, you approve, then I edit and commit.'
  : 'Design preview (no Electron bridge). Live data appears when launched as the desktop app.';

/**
 * What a reopened thread says in the dialogue box. It has to be the sentence still on screen after
 * the replayed turns are scrolled away, because the mistake it prevents — typing at a model that
 * was never shown any of this — is one an author makes at the bottom of the pane.
 */
const REOPENED = 'Reopened for reading — the agent has not been shown this conversation.';

let state: Convo = emptyConvo(OPENING);
let rev = 0;
/** Text waiting for a composer: written by a surface, taken by the pane once. */
let seeded: string | null = null;

export function convo(): Convo {
  return state;
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
 * The selected scene rides along as a prop, so it is in the provenance record beside what was
 * asked — what the author was looking at is part of what they meant. Main resolves it against the
 * project and drops it if it no longer names anything.
 */
export async function ask(text: string): Promise<void> {
  const input = text.trim();
  if (!input || state.busy) return;
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
  // Approving *is* the switch into execute mode; the agent will say so too, but the badge
  // should not lag the click that caused it.
  if (approved) setMode('execute');
}

/**
 * Answer the question card. Like `decide`, a reply rather than a command: main is parked inside
 * the agent's turn, so nothing about this is undoable and there is no provenance to record.
 * The empty string is allowed through — "nothing to add" is what the tool exists to hear.
 */
export function answer(text: string): void {
  const request = state.question;
  if (!request) return;
  set(answeredQuestion(state, text));
  void api.invoke('ask:answer', { id: request.id, answer: text.trim() });
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
 * Drop a targeted opener into the composer, so the next turn is scoped to what was clicked.
 * The pane focuses the field around it — a seed nobody is there to take is simply the text the
 * composer holds when one opens.
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

/** Subscribe to the agent's stream and its three permission doors. Called once, at boot. */
export function installAgent(): void {
  onAgentEvent((event) => set(received(state, event)));
  api.on('permission:plan', (request: PlanRequest) => set(proposed(state, request)));
  api.on('permission:ask', (request: AskRequest) => set(queried(state, request)));
  api.on('permission:confirm', (request: ConfirmRequest) => set(confirmAsked(state, request)));

  // Clearing and the thread commands follow the *command* rather than the button on the pane, so
  // the palette running the same id has the same effect. One route reaches neither —
  // `window.vn`/CDP, which goes straight to main — and none of these commands emits an event.
  onExec((id, outcome) => {
    if (!outcome.ok) return;
    if (id === 'agent.clear') {
      set(cleared(state, 'Conversation cleared. Back to plan mode.'));
      setMode('plan');
    } else if (id === 'agent.newThread') {
      set(cleared(state, 'New conversation. Tell me what to change.'));
      setMode('plan');
    } else if (id === 'agent.openThread') {
      const record = outcome.data as ThreadRecord | undefined;
      if (record) set(replayed(state, record.items, REOPENED));
      setMode('plan');
    } else if (id === 'upload.files' || id === 'upload.pick') {
      // The seeded turn is the command's sentence, not the model's — nothing has been asked yet,
      // which is the point: the conversation opens on the author's question, not on an answer.
      // `seed` is present only when bytes actually landed, so a cancelled dialog and an upload
      // where every file was refused both leave the conversation the author was having alone.
      const upload = outcome.data as { seed?: string; suggestions?: string[] } | undefined;
      if (!upload?.seed) return;
      set(offered(state, upload.seed, upload.suggestions ?? []));
      setMode('plan');
    }
  });
}
