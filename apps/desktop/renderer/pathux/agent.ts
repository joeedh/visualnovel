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
  asked,
  cleared,
  decided,
  emptyConvo,
  proposed,
  received,
  type Convo,
} from './convo.js';
import type { PlanRequest } from '../../src/shared/ipc.js';

const OPENING = isLive
  ? 'Workspace loaded. Tell me what to change — I plan first, you approve, then I edit and commit.'
  : 'Design preview (no Electron bridge). Live data appears when launched as the desktop app.';

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
 */
export async function ask(text: string): Promise<void> {
  const input = text.trim();
  if (!input || state.busy) return;
  set(asked(state, input));
  const outcome = await exec('agent.run', { input });
  set(answered(state, outcome.ok ? outcome.record.message : null));
}

/**
 * Answer the plan card. `plan:decision` is not a command — it is the reply to a request main is
 * already blocked on, and the agent's own permission gate owns what it means.
 */
export async function decide(approved: boolean): Promise<void> {
  const request = state.plan;
  if (!request) return;
  set(decided(state));
  void api.invoke('plan:decision', { id: request.id, decision: { approved } });
  // Approving *is* the switch into execute mode; the agent will say so too, but the badge
  // should not lag the click that caused it.
  if (approved) setMode('execute');
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

/** Subscribe to the agent's stream and to plan requests. Called once, from the shell's boot. */
export function installAgent(): void {
  onAgentEvent((event) => set(received(state, event)));
  api.on('permission:plan', (request: PlanRequest) => set(proposed(state, request)));

  // Clearing is a command, so the transcript follows the command rather than the button on the
  // pane: the palette running `agent.clear` empties this the same way. One reaches it and this
  // does not — `window.vn`/CDP, which goes straight to main, and `agent.clear` emits nothing.
  onExec((id, outcome) => {
    if (id !== 'agent.clear' || !outcome.ok) return;
    set(cleared(state, 'Conversation cleared. Back to plan mode.'));
    setMode('plan');
  });
}
