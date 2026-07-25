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
  Playable,
  SessionValue,
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

/** A tiny playable so the PLAY room renders in a plain-browser design preview. */
const MOCK_PLAYABLE: Playable = {
  version: 1,
  title: 'sample',
  start: 'rooftop_intro',
  characters: {
    aiko: { name: 'Aiko' },
    haruki: { name: 'Haruki' },
  },
  scenes: {
    rooftop_intro: {
      beats: [
        { type: 'show' },
        { type: 'narrate', text: 'The rooftop door swings open. Haruki is already there.' },
        { type: 'say', who: 'aiko', text: "Oh — sorry. I didn't think anyone came up here." },
        { type: 'say', who: 'haruki', text: "Most people don't. That's the appeal." },
      ],
      choices: [
        { label: 'Step up beside him', goto: 'aiko_confession' },
        { label: 'Head back inside', goto: 'rooftop_intro' },
      ],
    },
    aiko_confession: {
      beats: [
        { type: 'show' },
        { type: 'say', who: 'aiko', text: 'The new girl gets the quiet places, I guess.' },
        { type: 'narrate', text: 'A faint, dry smile. She finds herself smiling too.' },
      ],
      choices: [],
    },
  },
};

/**
 * The browser preview has no main process to persist to, so the session store's role is
 * played by `localStorage` — enough that the resizable panels behave identically there.
 */
const PREVIEW_SESSION = 'vn.session';

function previewSession(): Record<string, SessionValue> {
  try {
    return JSON.parse(localStorage.getItem(PREVIEW_SESSION) ?? '{}') as Record<
      string,
      SessionValue
    >;
  } catch {
    return {};
  }
}

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
      case 'story:play':
        return Promise.resolve(MOCK_PLAYABLE);
      // The catalog is a projection of the live registry, which a browser preview has no
      // access to; an empty one keeps the palette rendering rather than throwing.
      case 'command:catalog':
        return Promise.resolve({ version: 1, source: '(preview)', commands: [] });
      case 'command:history':
        return Promise.resolve([]);
      case 'command:exec':
        return Promise.resolve({ ok: false, error: '(preview) no command stack' });
      case 'command:undo':
      case 'command:redo':
        return Promise.resolve({ ok: false, error: '(preview) undo is not implemented' });
      default:
        return Promise.resolve(undefined);
    }
  }) as DesktopApi['invoke'],
  on: () => () => {},
  session: {
    initial: previewSession,
    set: (key, value) => {
      localStorage.setItem(PREVIEW_SESSION, JSON.stringify({ ...previewSession(), [key]: value }));
    },
  },
};

export const api: DesktopApi = window.api ?? fallback;

/** Subscribe to an agent event stream; returns an unsubscribe. */
export function onAgentEvent(listener: (event: AgentEvent) => void): () => void {
  return api.on('agent:event', listener as (p: EventChannels['agent:event']) => void);
}
