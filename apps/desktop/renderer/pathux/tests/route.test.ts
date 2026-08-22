import { EDITOR_IDS, isTextPath } from '../../../src/shared/editors.js';
import type { DocNode, DocNodeKind, EditorId } from '../../../src/shared/ipc.js';
import type { Pane } from '../panes.js';
import { routeFor, type Route } from '../route.js';

const pane = (editor: string): Pane => ({
  editor,
  chrome: false,
  floating: false,
  active: false,
  width: 400,
  height: 400,
});

const documents = [pane('documents')];

const node = (kind: DocNodeKind, over: Partial<DocNode> = {}): DocNode => ({
  id: `${kind}:x`,
  kind,
  label: 'x',
  ...over,
});

/** Every kind, and the node the table below routes for it. */
const NODES: Record<DocNodeKind, DocNode> = {
  branch: node('branch', { id: 'branch:story', label: 'Story' }),
  scene: node('scene', { id: 'scene:greet', path: 'scenes/greet.md' }),
  shot: node('shot', { id: 'shot:greet/greet__s1' }),
  character: node('character', { id: 'character:aiko', path: 'characters/aiko.md' }),
  location: node('location', { id: 'location:cafe', path: 'locations/cafe.md' }),
  wikidir: node('wikidir', { id: 'wikidir:wiki/lore' }),
  wiki: node('wiki', { id: 'wiki:wiki/lore/tea.md', path: 'wiki/lore/tea.md' }),
  assetkind: node('assetkind', { id: 'assetkind:portrait' }),
  asset: node('asset', { id: 'asset:a1b2c3' }),
  slot: node('slot', { id: 'slot:plate:cafe/night' }),
  skill: node('skill', {
    id: 'skill:continuity-pass',
    path: '.aiagent/skills/continuity-pass/SKILL.md',
  }),
  dir: node('dir', { id: 'dir:art' }),
  file: node('file', { id: 'file:notes.md', path: 'notes.md' }),
  more: node('more', { id: 'more:assets' }),
};

/** With nothing but the tree open, which editor each kind reaches. */
const WITH_NOTHING_OPEN: Record<DocNodeKind, EditorId | ''> = {
  branch: '',
  scene: 'script',
  shot: 'timeline',
  character: 'wiki',
  location: 'wiki',
  wikidir: '',
  wiki: 'wiki',
  assetkind: '',
  asset: 'asset',
  // Taskgraph is the one pane that can draw a slot that has no bytes yet.
  slot: 'taskgraph',
  // Skills answers for a `SKILL.md`, and Wiki deliberately does not claim one: a plain text box
  // would let an author edit the front-matter the Skills pane owns.
  skill: 'skills',
  dir: '',
  file: 'wiki',
  more: '',
};

const opened = (route: Route): EditorId | '' => (route.action === 'open' ? route.editor : '');

describe('where a clicked node goes', () => {
  test.each(Object.keys(NODES) as DocNodeKind[])('a %s with nothing else open', (kind) => {
    const route = routeFor({ node: NODES[kind], panes: documents });
    expect(opened(route)).toBe(WITH_NOTHING_OPEN[kind]);
  });

  test('a claimant that is up is focused rather than opened again', () => {
    const route = routeFor({ node: NODES.wiki, panes: [...documents, pane('wiki')] });
    expect(route).toEqual({
      action: 'open',
      editor: 'wiki',
      where: 'here',
      subject: 'wiki/lore/tea.md',
    });
  });

  test('a claimant that is not up goes anywhere but the pane that asked', () => {
    const route = routeFor({ node: NODES.asset, panes: documents });
    expect(route).toEqual({
      action: 'open',
      editor: 'asset',
      where: 'elsewhere',
      subject: 'a1b2c3',
    });
  });

  test('a grouping claims nothing, so the selection was the whole act', () => {
    expect(routeFor({ node: NODES.branch, panes: documents })).toEqual({ action: 'select' });
  });
});

describe('visibility outranks tier', () => {
  test('a visible secondary beats a hidden primary', () => {
    const route = routeFor({ node: NODES.scene, panes: [...documents, pane('timeline')] });
    expect(opened(route)).toBe('timeline');
    expect(route).toMatchObject({ where: 'here' });
  });

  test('and loses to a visible primary', () => {
    const panes = [...documents, pane('timeline'), pane('script')];
    expect(opened(routeFor({ node: NODES.scene, panes }))).toBe('script');
  });

  test('two visible secondaries fall back to EDITORS order', () => {
    // Branches and Shot Coverage both claim a scene as `secondary`; Branches is listed first.
    const panes = [...documents, pane('timeline'), pane('branches')];
    expect(opened(routeFor({ node: NODES.scene, panes }))).toBe('branches');
  });
});

describe('a claim looks at the node, not just its kind', () => {
  test('an entity with no sheet of its own is claimed by nobody', () => {
    const route = routeFor({ node: node('location', { id: 'location:mined' }), panes: documents });
    expect(opened(route)).toBe('');
  });

  test('a binary file in file mode is not read as a document', () => {
    const png = node('file', { id: 'file:art/cafe.png', path: 'art/cafe.png' });
    expect(opened(routeFor({ node: png, panes: documents }))).toBe('');
  });

  // Skills and Wiki both claim a `SKILL.md` as `primary`, so the tie breaks on `EDITORS` order,
  // which lists `skills` before `wiki`.
  test('a skill file clicked in file mode lands in Skills rather than Wiki', () => {
    const file = node('file', {
      id: 'file:.aiagent/skills/continuity-pass/SKILL.md',
      path: '.aiagent/skills/continuity-pass/SKILL.md',
    });
    expect(opened(routeFor({ node: file, panes: documents }))).toBe('skills');
  });

  // Visibility still comes first, so the click lands where the author is looking.
  test('but lands in Wiki when Wiki is up and Skills is not', () => {
    const file = node('file', {
      id: 'file:.aiagent/skills/continuity-pass/SKILL.md',
      path: '.aiagent/skills/continuity-pass/SKILL.md',
    });
    expect(opened(routeFor({ node: file, panes: [...documents, pane('wiki')] }))).toBe('wiki');
  });
});

describe('the subject that travels with the open', () => {
  test('is a path for a document editor and a hash for the asset editor', () => {
    expect(routeFor({ node: NODES.character, panes: documents })).toMatchObject({
      subject: 'characters/aiko.md',
    });
    expect(routeFor({ node: NODES.asset, panes: documents })).toMatchObject({ subject: 'a1b2c3' });
  });

  test('is empty for an editor whose subject needs more than one string', () => {
    expect(routeFor({ node: NODES.shot, panes: documents })).toMatchObject({ subject: '' });
  });
});

describe('what counts as text', () => {
  test.each(['a.md', 'wiki/x.TXT', 'scenes/greet.fountain', 'project.yaml', 'p.json'])(
    '%s',
    (path) => expect(isTextPath(path)).toBe(true),
  );

  test.each(['art/cafe.png', 'a.mdx', 'README', undefined])('%s is not', (path) =>
    expect(isTextPath(path)).toBe(false),
  );
});

test('every editor a claim names is a real editor', () => {
  for (const kind of Object.keys(NODES) as DocNodeKind[]) {
    const route = routeFor({ node: NODES[kind], panes: documents });
    if (route.action === 'open') expect(EDITOR_IDS).toContain(route.editor);
  }
});
