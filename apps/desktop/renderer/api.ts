/**
 * Typed access to the main process. In Electron this is the preload-injected `window.api`;
 * in a plain browser (e.g. opening the built `index.html` for a design preview) it falls
 * back to static mock data so the UI still renders. `isLive` tells the UI which it is.
 */
import type {
  AgentEvent,
  DesktopApi,
  EventChannels,
  PipelineStatus,
  Task,
  WorkspaceIndex,
} from '../src/shared/ipc';

export const isLive = Boolean(window.api);

const MOCK_INDEX: WorkspaceIndex = {
  root: '~/stories/sample',
  title: 'sample',
  screenplay: 'screenplay/rooftop.fountain',
  entry: 'rooftop_intro',
  characters: [
    { id: 'aiko', name: 'Aiko', status: 'approved', file: 'characters/aiko/character.md' },
    { id: 'haruki', name: 'Haruki', status: 'candidates', file: 'characters/haruki/character.md' },
  ],
  locations: [{ id: 'rooftop', name: 'Rooftop', mined: true, file: 'locations/rooftop.md' }],
  scenes: [
    {
      id: 'rooftop_intro',
      location: 'rooftop',
      characters: ['aiko', 'haruki'],
      choices: 2,
      reachable: true,
    },
    {
      id: 'aiko_confession',
      location: 'rooftop',
      characters: ['aiko'],
      choices: 1,
      reachable: true,
    },
    {
      id: 'haruki_route',
      location: 'rooftop',
      characters: ['haruki'],
      choices: 0,
      reachable: false,
    },
  ],
  diagnostics: [
    { severity: 'warning', code: 'gate.pending', message: 'Haruki has no approved portrait' },
    {
      severity: 'error',
      code: 'graph.reachable',
      message: 'Scene haruki_route unreachable from entry',
    },
  ],
};

const MOCK_TASKS = [
  { hash: '7a2f', kind: 'location_ref', deps: [], status: 'done', attempts: [] },
  { hash: 'b3c1', kind: 'portrait', deps: ['7a2f'], status: 'done', attempts: [] },
  { hash: '9e0a', kind: 'portrait', deps: [], status: 'done', attempts: [] },
  { hash: '44d8', kind: 'model_sheet', deps: ['b3c1'], status: 'running', attempts: [] },
  { hash: '7b2d', kind: 'model_sheet', deps: ['9e0a'], status: 'failed', attempts: [] },
  { hash: '8c0e', kind: 'shot_image', deps: ['44d8'], status: 'needs_human', attempts: [] },
] as unknown as Task[];

const MOCK_STATUS: PipelineStatus = {
  tasks: MOCK_TASKS,
  gatePending: ['haruki'],
  blockedOnGate: true,
};

const MOCK_CANDIDATES = [
  { hash: '9e0a1b', accepted: false },
  { hash: '9e0a2c', accepted: false },
  { hash: '9e0a3d', accepted: false },
];

/** A do-nothing API backed by mock data, used when no preload bridge is present. */
const fallback: DesktopApi = {
  invoke: ((channel: string, arg?: unknown) => {
    switch (channel) {
      case 'workspace:index':
        return Promise.resolve(MOCK_INDEX);
      case 'pipeline:status':
        return Promise.resolve(MOCK_STATUS);
      case 'agent:setMode':
        return Promise.resolve('plan');
      case 'agent:setModel':
        return Promise.resolve(String(arg));
      case 'gate:candidates':
        return Promise.resolve(MOCK_CANDIDATES);
      case 'gate:approve':
        return Promise.resolve({ ok: true, message: '(preview) approved' });
      default:
        return Promise.resolve(undefined);
    }
  }) as DesktopApi['invoke'],
  on: () => () => {},
};

export const api: DesktopApi = window.api ?? fallback;

/** Subscribe to an agent event stream; returns an unsubscribe. */
export function onAgentEvent(listener: (event: AgentEvent) => void): () => void {
  return api.on('agent:event', listener as (p: EventChannels['agent:event']) => void);
}
