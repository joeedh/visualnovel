/**
 * Typed access to the main process. In Electron this is the preload-injected `window.api`;
 * in a plain browser (e.g. opening the built `index.html` for a design preview) it falls
 * back to static mock data so the UI still renders. `isLive` tells the UI which it is.
 */
import type {
  AgentEvent,
  DesktopApi,
  DocNode,
  DocTree,
  EventChannels,
  PipelineStatus,
  Playable,
  SessionValue,
  StoryGraph,
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
  bibleFiles: 0,
  baseAssets: { state: 'ready', root: '~/stories/sample/assets', count: 6 },
  repos: [{ role: 'project', root: '~/stories/sample', owned: true }],
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
  slots: [],
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
  portraitOverlay: false,
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

/** The same story as a branch graph, so the editor has something to draw in the preview. */
const MOCK_GRAPH: StoryGraph = {
  start: 'rooftop_intro',
  scenes: [
    {
      id: 'rooftop_intro',
      location: 'rooftop',
      synopsis: 'Aiko finds Haruki already on the roof.',
      characters: ['aiko', 'haruki'],
      lines: 4,
      reachable: true,
    },
    {
      id: 'aiko_confession',
      location: 'rooftop',
      synopsis: 'She stays, and says the quiet part.',
      characters: ['aiko'],
      lines: 3,
      reachable: true,
    },
    {
      id: 'hallway',
      location: 'hallway',
      synopsis: 'A scene nothing points at yet.',
      characters: [],
      lines: 1,
      reachable: false,
    },
  ],
  edges: [
    {
      id: 'rooftop_intro#choice:0',
      from: 'rooftop_intro',
      to: 'aiko_confession',
      kind: 'choice',
      label: 'Step up beside him',
      index: 0,
      dangling: false,
    },
    {
      id: 'rooftop_intro#choice:1',
      from: 'rooftop_intro',
      to: 'rooftop_intro',
      kind: 'choice',
      label: 'Head back inside',
      index: 1,
      dangling: false,
    },
  ],
  diagnostics: [
    { severity: 'warning', code: 'unreachable_scene', message: 'unreachable', where: 'hallway' },
  ],
};

/**
 * The same story as a document tree, carrying the authored branches only. The assets branch is a
 * projection of a manifest a preview has not got, and an empty one would misrepresent the shape.
 */
const MOCK_DOCTREE: DocTree = {
  roots: [
    {
      id: 'branch:story',
      kind: 'branch',
      label: 'Story',
      children: [
        {
          id: 'scene:rooftop_intro',
          kind: 'scene',
          label: 'rooftop_intro',
          path: 'scenes/rooftop_intro.md',
          children: [
            {
              id: 'shot:rooftop_intro/rooftop_intro__s1',
              kind: 'shot',
              label: 'rooftop_intro__s1',
              badge: 'wide',
            },
          ],
        },
        {
          id: 'scene:aiko_confession',
          kind: 'scene',
          label: 'aiko_confession',
          path: 'scenes/aiko_confession.md',
        },
        {
          id: 'scene:haruki_route',
          kind: 'scene',
          label: 'haruki_route',
          path: 'scenes/haruki_route.md',
          badge: 'unreachable',
        },
      ],
    },
    {
      id: 'branch:characters',
      kind: 'branch',
      label: 'Characters',
      children: [
        {
          id: 'character:aiko',
          kind: 'character',
          label: 'Aiko',
          path: 'characters/aiko/character.md',
          badge: 'approved',
        },
        {
          id: 'character:haruki',
          kind: 'character',
          label: 'Haruki',
          path: 'characters/haruki/character.md',
          badge: 'candidates',
        },
      ],
    },
    {
      id: 'branch:locations',
      kind: 'branch',
      label: 'Locations',
      children: [
        {
          id: 'location:rooftop',
          kind: 'location',
          label: 'Rooftop',
          path: 'locations/rooftop.md',
        },
      ],
    },
    {
      id: 'branch:wiki',
      kind: 'branch',
      label: 'Wiki',
      children: [
        { id: 'wiki:history.md', kind: 'wiki', label: 'History', path: 'wiki/history.md' },
      ],
    },
    {
      id: 'branch:skills',
      kind: 'branch',
      label: 'Skills',
      children: [
        {
          id: 'skill:continuity-pass',
          kind: 'skill',
          label: 'Continuity pass',
          path: '.aiagent/skills/continuity-pass/SKILL.md',
          note: 'Re-read a scene against the bible and list what contradicts it.',
        },
        {
          id: 'skill:lint-fountain',
          kind: 'skill',
          label: 'Lint the screenplay',
          path: '.aiagent/skills/lint-fountain/SKILL.md',
          badge: 'script',
          note: 'Run the Fountain checker over every scene and summarise what it says.',
        },
      ],
    },
  ],
  backlinks: {},
  pathIndex: {},
};

/** The same workspace as files on disk, for the sidebar's other mode. */
const MOCK_FILETREE: DocNode[] = [
  {
    id: 'dir:characters',
    kind: 'dir',
    label: 'characters',
    path: 'characters',
    children: [
      {
        id: 'file:characters/aiko/character.md',
        kind: 'file',
        label: 'character.md',
        path: 'characters/aiko/character.md',
      },
    ],
  },
  {
    id: 'dir:scenes',
    kind: 'dir',
    label: 'scenes',
    path: 'scenes',
    children: [
      {
        id: 'file:scenes/rooftop_intro.md',
        kind: 'file',
        label: 'rooftop_intro.md',
        path: 'scenes/rooftop_intro.md',
      },
    ],
  },
  { id: 'file:project.yaml', kind: 'file', label: 'project.yaml', path: 'project.yaml' },
];

/**
 * The contents of the two mock skills, as the Skills pane draws them. Every node carries the
 * workspace-relative path `doc.read` would take, and `lint-fountain` carries the script its
 * badge claims.
 */
const MOCK_SKILLTREE: DocNode[] = [
  {
    id: 'dir:.aiagent/skills/continuity-pass',
    kind: 'dir',
    label: 'continuity-pass',
    path: '.aiagent/skills/continuity-pass',
    children: [
      {
        id: 'file:.aiagent/skills/continuity-pass/SKILL.md',
        kind: 'file',
        label: 'SKILL.md',
        path: '.aiagent/skills/continuity-pass/SKILL.md',
      },
    ],
  },
  {
    id: 'dir:.aiagent/skills/lint-fountain',
    kind: 'dir',
    label: 'lint-fountain',
    path: '.aiagent/skills/lint-fountain',
    children: [
      {
        id: 'file:.aiagent/skills/lint-fountain/SKILL.md',
        kind: 'file',
        label: 'SKILL.md',
        path: '.aiagent/skills/lint-fountain/SKILL.md',
      },
      {
        id: 'file:.aiagent/skills/lint-fountain/run.mjs',
        kind: 'file',
        label: 'run.mjs',
        path: '.aiagent/skills/lint-fountain/run.mjs',
      },
    ],
  },
];

/**
 * The browser preview has no main process to persist to, so `localStorage` stands in for the
 * session store. That is enough for the resizable panels to behave identically there.
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
      case 'workspace:doctree':
        return Promise.resolve(MOCK_DOCTREE);
      case 'workspace:filetree':
        return Promise.resolve(MOCK_FILETREE);
      case 'workspace:skilltree':
        return Promise.resolve(MOCK_SKILLTREE);
      case 'pipeline:status':
        return Promise.resolve(MOCK_STATUS);
      // A preview has no project, so there is no AICONTEXT.md and no map. The built-in half of
      // the prompt is a constant, so the pane shows that rather than nothing
      case 'agent:system':
        return Promise.resolve({
          sections: [{ name: 'BUILT-IN', text: '(preview) no project open' }],
          files: [],
          modelId: '',
        });
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
      case 'story:graph':
        return Promise.resolve(MOCK_GRAPH);
      // The catalog is a projection of the live registry, which a browser preview has no
      // access to; an empty one keeps the palette rendering rather than throwing.
      case 'command:catalog':
        return Promise.resolve({ version: 1, source: '(preview)', commands: [] });
      case 'command:history':
        return Promise.resolve([]);
      // A preview has no project, and the log lives in one. An empty list leaves the bell at
      // zero unread and the dialog reporting that nothing has happened yet
      case 'notify:list':
        return Promise.resolve([]);
      case 'notify:post':
        return Promise.reject(new Error('(preview) no notification log'));
      // Nothing can be waiting on approval without a project to draw it for
      case 'approval:list':
        return Promise.resolve([]);
      case 'command:exec':
        return Promise.resolve({ ok: false, error: '(preview) no command stack' });
      // Answers `undeclared` rather than `refuse`, because a preview has no precondition to
      // consult and a refusal would show the palette a sentence no command produced
      case 'command:check':
        return Promise.resolve({ state: 'undeclared', message: '(preview) no command stack' });
      // Undo restores a git snapshot of the workspace, and a browser preview has no workspace,
      // so both controls stay disabled here
      case 'command:undo':
      case 'command:redo':
        return Promise.resolve({ ok: false, error: '(preview) no workspace to restore' });
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
