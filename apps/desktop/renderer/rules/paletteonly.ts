/**
 * The commands no drawn control runs, each with the reason. `match` is a command id, a namespace
 * (`workspace.*`) or a name (`*.list`); one `*` at either end and nothing else, so a glob can only
 * cover what its sentence covers. The list is checked both ways against the live registry: a command
 * with no control and no entry fails, and so does an entry that matches nothing without a control.
 */
export interface PaletteOnly {
  match: string;
  why: string;
}

const NAMESPACES: readonly PaletteOnly[] = [
  {
    match: 'tour.*',
    why  : 'The tour layer advances itself; no editor draws a tour control.',
  },
  {
    match: 'plugin.*',
    why: 'Plugins are installed, listed and priced from the palette and CDP; no editor draws a plugin control.',
  },
  {
    match: 'interaction.*',
    why  : 'The drag layer’s own queries, answered over IPC rather than drawn.',
  },
];

const WORKSPACE = [
  'workspace.chooseDirectory',
  'workspace.doctree',
  'workspace.filetree',
  'workspace.import',
  'workspace.index',
  'workspace.recent',
  'workspace.skills',
  'workspace.skilltree',
].map((match) => ({
  match,
  why: 'A workspace read, or an import, that the launcher, the panes’ own fetches and CDP run; the app menu draws the rest of the namespace.',
}));

const NOTIFY: readonly PaletteOnly[] = [
  {
    match: 'notify.markRead',
    why: 'Following a notification marks it read on the way; the palette and CDP mark one read without following it.',
  },
];

const NAMES: readonly PaletteOnly[] = [
  { match: '*.list', why: 'A listing the palette and CDP answer; nothing is drawn for it.' },
  { match: '*.info', why: 'A read the palette and CDP answer; nothing is drawn for it.' },
  { match: '*.status', why: 'A status read the palette and CDP answer; nothing is drawn for it.' },
  { match: '*.state', why: 'A state read the palette and CDP answer; nothing is drawn for it.' },
];

const READS = [
  'agent.threads',
  'asset.suspended',
  'bible.search',
  'command.check',
  'doc.read',
  'gate.candidates',
  'gengraph.listGroups',
  'project.keyStatus',
  'project.pagesStatus',
  'story.coverage',
  'story.graph',
].map((match) => ({
  match,
  why: 'A read whose answer feeds an editor or the agent; the palette and CDP run it, no control does.',
}));

const VIEW = ['view.close', 'view.focus', 'view.layout', 'view.layouts', 'view.palette'].map(
  (match) => ({
    match,
    why: 'Pane management the hotkeys, the docker’s own chrome and a menu row’s `then` list run; the View menu draws the rest of the namespace.',
  }),
);

const APP: readonly PaletteOnly[] = [
  { match: 'app.openReleases', why: 'Reached from the update notification.' },
  {
    match: 'app.keyGuide',
    why  : 'The onboarding editor reads the guide’s text through it; no control runs it.',
  },
];

const GENGRAPH_NODES = [
  'gengraph.addBoundary',
  'gengraph.addGroup',
  'gengraph.addNode',
  'gengraph.apply',
  'gengraph.expose',
  'gengraph.link',
  'gengraph.moveNodes',
  'gengraph.removeBoundary',
  'gengraph.reorderExposed',
  'gengraph.repointExposed',
  'gengraph.setActiveOutput',
  'gengraph.setProp',
  'gengraph.unexpose',
  'gengraph.unlink',
].map((match) => ({
  match,
  why: 'An edit the graph canvas makes through its node widgets, sockets and drags, outside `controls`.',
}));

const STORY: readonly PaletteOnly[] = [
  ...['story.deleteLine', 'story.setNext'].map((match) => ({
    match,
    why: 'The script column runs it from a keystroke or a pending scene, not from a drawn control.',
  })),
  ...['story.moveLine', 'story.moveShot'].map((match) => ({
    match,
    why: 'A drag interaction; the drag layer runs it when the drop lands.',
  })),
  ...['story.removeChoice', 'story.spliceScene'].map((match) => ({
    match,
    why: 'A branch-structure edit no editor draws yet; the palette and the agent reach it.',
  })),
  ...['story.play', 'story.export'].map((match) => ({
    match,
    why: 'The playable is built and exported from the menu bar and the palette.',
  })),
];

const PROMPT: readonly PaletteOnly[] = [
  {
    match: 'prompt.moveChunk',
    why  : 'A drag interaction; the drag layer runs it when the drop lands.',
  },
  { match: 'prompt.repin', why: 'Reached from the palette; no clause control repins.' },
];

const CONVERSATIONS: readonly PaletteOnly[] = [
  ...['report.agent', 'report.openIssue', 'report.say'].map((match) => ({
    match,
    why: 'The report conversation runs it from its input line and its preview dialog, not from `controls`.',
  })),
  ...['agent.clear', 'agent.renameThread'].map((match) => ({
    match,
    why: 'The conversation’s input line and the thread list run it directly.',
  })),
  { match: 'upload.files', why: 'Uploads come from the drop target.' },
];

export const PALETTE_ONLY: readonly PaletteOnly[] = [
  ...NAMESPACES,
  ...WORKSPACE,
  ...NOTIFY,
  ...NAMES,
  ...READS,
  ...VIEW,
  ...APP,
  ...GENGRAPH_NODES,
  ...STORY,
  ...PROMPT,
  ...CONVERSATIONS,
];
