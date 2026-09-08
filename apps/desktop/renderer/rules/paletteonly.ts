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
    match: 'workspace.*',
    why: 'A workspace is opened, created, indexed and imported from the menu bar, the launcher and CDP, before any editor exists.',
  },
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

const WINDOW = ['window.new', 'window.close', 'window.quit'].map((match) => ({
  match,
  why: 'Window lifecycle belongs to the menu bar, the hotkeys and the OS rather than to a pane.',
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

const VIEW = [
  'view.close',
  'view.focus',
  'view.layout',
  'view.layouts',
  'view.palette',
  'view.resetLayout',
  'view.saveLayout',
].map((match) => ({
  match,
  why: 'Pane management from the View menu, the hotkeys and the docker’s own chrome; only opening and applying a layout are drawn.',
}));

const APP: readonly PaletteOnly[] = [
  { match: 'app.checkForUpdates', why: 'Reached from the Help menu.' },
  { match: 'app.openReleases', why: 'Reached from the Help menu and the update notification.' },
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
  'gengraph.duplicateNode',
  'gengraph.expose',
  'gengraph.link',
  'gengraph.moveNodes',
  'gengraph.removeBoundary',
  'gengraph.removeNode',
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
  ...['story.insertLine', 'story.deleteLine', 'story.setSpeaker', 'story.setNext'].map((match) => ({
    match,
    why: 'The script column runs it from a keystroke, the cue picker or a pending scene, not from a drawn control.',
  })),
  ...[
    'story.deleteShot',
    'story.setSubjects',
    'story.setVariant',
    'story.requireCast',
    'story.setSceneOutfit',
  ].map((match) => ({
    match,
    why: 'The timeline runs it from a per-shot or per-character widget outside `controls`.',
  })),
  ...['story.moveLine', 'story.moveShot'].map((match) => ({
    match,
    why: 'A drag interaction; the drag layer runs it when the drop lands.',
  })),
  ...['story.setChoice', 'story.removeChoice', 'story.spliceScene'].map((match) => ({
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
  ...['agent.clear', 'agent.editLine', 'agent.renameThread'].map((match) => ({
    match,
    why: 'The conversation’s input line, the thread list and the script column’s line editor run it directly.',
  })),
  ...['upload.files', 'upload.pick'].map((match) => ({
    match,
    why: 'Uploads come from the drop target and the File menu.',
  })),
];

const MENU_BAR: readonly PaletteOnly[] = [
  { match: 'pipeline.approveAndRun', why: 'A menu-bar item opened as a command dialog.' },
  { match: 'project.installPages', why: 'A menu-bar item opened as a command dialog.' },
];

export const PALETTE_ONLY: readonly PaletteOnly[] = [
  ...NAMESPACES,
  ...WINDOW,
  ...NOTIFY,
  ...NAMES,
  ...READS,
  ...VIEW,
  ...APP,
  ...GENGRAPH_NODES,
  ...STORY,
  ...PROMPT,
  ...CONVERSATIONS,
  ...MENU_BAR,
];
