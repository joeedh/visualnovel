import {
  HEADER,
  commandKey,
  itemKey,
  mapOf,
  resolveAnchor,
  resolveItem,
  subsumes,
  type Anchor,
  type AnchorMap,
  type LiveAnchors,
} from '../anchors.js';
import type { EditorId } from '../../../src/shared/editors.js';

const node = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
};

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  key: commandKey('asset.regenerate'),
  id: 'asset.regenerate',
  props: { hash: 'a1b2' },
  enabled: true,
  editor: 'asset' as EditorId,
  via: { kind: 'dom', node },
  ...over,
});

const live = (anchors: Anchor[], over: Partial<LiveAnchors> = {}): LiveAnchors => ({
  anchors,
  open: ['asset' as EditorId],
  ...over,
});

const map: AnchorMap = { editorsFor: { 'asset.regenerate': ['asset' as EditorId] } };

describe('keys', () => {
  it('names a command and a thing differently', () => {
    expect(commandKey('asset.regenerate')).toBe('cmd:asset.regenerate');
    expect(itemKey('asset', 'a1b2')).toBe('item:asset/a1b2');
  });
});

describe('subsumes', () => {
  it('accepts a step whose props the anchor already records', () => {
    expect(subsumes(anchor(), { id: 'asset.regenerate', props: { hash: 'a1b2' } })).toEqual({
      state: 'ready',
    });
  });

  it('refuses a step naming a different value for a prop the anchor records', () => {
    expect(subsumes(anchor(), { id: 'asset.regenerate', props: { hash: 'ffff' } })).toEqual({
      state: 'wrong-subject',
      needs: { id: 'asset.regenerate', props: { hash: 'ffff' } },
    });
  });

  it('reads a prop only the step names as something to type, when the widget supplies it', () => {
    const box = anchor({
      id: 'art.setNotes',
      props: { target: 'location:cafe/night' },
      supplies: ['notes'],
    });
    expect(
      subsumes(box, {
        id: 'art.setNotes',
        props: { target: 'location:cafe/night', notes: 'dusk' },
      }),
    ).toEqual({ state: 'input', supplies: ['notes'] });
  });

  it('is ready when the step names none of what the widget supplies', () => {
    const box = anchor({ id: 'art.setNotes', props: { target: 'x' }, supplies: ['notes'] });
    expect(subsumes(box, { id: 'art.setNotes', props: { target: 'x' } })).toEqual({
      state: 'ready',
    });
  });

  it('refuses a prop the anchor neither records nor supplies, rather than hiding it', () => {
    const box = anchor({ id: 'art.setNotes', props: { target: 'x' } });
    expect(subsumes(box, { id: 'art.setNotes', props: { target: 'x', notes: 'dusk' } })).toEqual({
      state: 'wrong-subject',
      needs: { id: 'art.setNotes', props: { notes: 'dusk' } },
    });
  });

  it('compares a list prop by its members', () => {
    const many = anchor({ id: 'pipeline.run', props: { only: ['a', 'b'] } });
    expect(subsumes(many, { id: 'pipeline.run', props: { only: ['a', 'b'] } }).state).toBe('ready');
    expect(subsumes(many, { id: 'pipeline.run', props: { only: ['a'] } }).state).toBe(
      'wrong-subject',
    );
  });
});

describe('a graph node', () => {
  const card = (): Anchor => ({
    key: itemKey('scene', 'greet'),
    props: {},
    enabled: true,
    publishes: { sceneId: 'greet' },
    editor: 'branches' as EditorId,
    via: { kind: 'pick', nodeId: 'greet', node },
  });

  it('resolves as the place its subject is chosen', () => {
    expect(
      resolveItem(live([card()], { open: ['branches' as EditorId] }), 'scene', 'greet'),
    ).toEqual({ state: 'ready', anchor: card() });
  });

  it('is nowhere when the graph does not draw it', () => {
    expect(resolveItem(live([card()]), 'scene', 'ending')).toEqual({ state: 'absent' });
  });
});

describe('a form anchor', () => {
  const door = anchor({ id: 'pipeline.run', props: {}, form: true });

  it('reads every prop the step names as something typed in the form', () => {
    expect(subsumes(door, { id: 'pipeline.run', props: { mock: true, only: 'greet' } })).toEqual({
      state: 'input',
      supplies: ['mock', 'only'],
    });
  });

  it('still refuses a step naming a different value for a prop it records', () => {
    const scoped = anchor({ id: 'gate.approve', props: { characterId: 'aiko' }, form: true });
    expect(subsumes(scoped, { id: 'gate.approve', props: { characterId: 'haruki' } })).toEqual({
      state: 'wrong-subject',
      needs: { id: 'gate.approve', props: { characterId: 'haruki' } },
    });
  });
});

describe('resolveAnchor', () => {
  const step = { id: 'asset.regenerate', props: { hash: 'a1b2' } };

  it('is ready for a drawn, enabled anchor', () => {
    const found = resolveAnchor(map, live([anchor()]), step);
    expect(found.state).toBe('ready');
  });

  it('reports the rule’s own sentence for a greyed control', () => {
    const greyed = anchor({ enabled: false, reason: 'The asset is suspended.' });
    expect(resolveAnchor(map, live([greyed]), step)).toEqual({
      state: 'disabled',
      anchor: greyed,
      reason: 'The asset is suspended.',
    });
  });

  it('asks for a scroll before saying anything else about an anchor that is off screen', () => {
    const greyed = anchor({ enabled: false, reason: 'nope' });
    const found = resolveAnchor(map, live([greyed], { offscreen: [greyed.key] }), step);
    expect(found.state).toBe('offscreen');
  });

  it('names what has to change when the pane is showing something else', () => {
    const elsewhere = anchor({ props: { hash: 'ffff' } });
    expect(resolveAnchor(map, live([elsewhere]), step)).toEqual({
      state: 'wrong-subject',
      anchor: elsewhere,
      needs: { id: 'asset.regenerate', props: { hash: 'a1b2' } },
    });
  });

  it('prefers a matching anchor over one on the wrong subject', () => {
    const found = resolveAnchor(map, live([anchor({ props: { hash: 'ffff' } }), anchor()]), step);
    expect(found.state).toBe('ready');
  });

  it('says the pane is closed when the map knows where the command lives', () => {
    expect(resolveAnchor(map, live([], { open: [] }), step)).toEqual({
      state: 'pane-closed',
      editor: 'asset',
    });
  });

  it('says absent, not pane-closed, for a command the toolbar alone anchors', () => {
    const toolbar: AnchorMap = { editorsFor: { 'pipeline.run': [HEADER] } };
    const found = resolveAnchor(toolbar, live([], { open: [] }), { id: 'pipeline.run', props: {} });
    expect(found).toEqual({ state: 'absent' });
  });

  it('names the pane when a command is anchored both in the toolbar and in one', () => {
    const both: AnchorMap = { editorsFor: { 'pipeline.run': [HEADER, 'tasklist' as EditorId] } };
    const found = resolveAnchor(both, live([], { open: [] }), { id: 'pipeline.run', props: {} });
    expect(found).toEqual({ state: 'pane-closed', editor: 'tasklist' });
  });

  it('says absent when the pane is open and the control was not drawn', () => {
    expect(resolveAnchor(map, live([]), step)).toEqual({ state: 'absent' });
  });

  it('says unanchored when no editor anchors the command at all', () => {
    expect(resolveAnchor({ editorsFor: {} }, live([]), step)).toEqual({ state: 'unanchored' });
  });

  it('never matches an item anchor against a command step', () => {
    const row = anchor({ key: itemKey('asset', 'a1b2'), props: {} });
    delete (row as { id?: string }).id;
    expect(resolveAnchor({ editorsFor: {} }, live([row]), step)).toEqual({ state: 'unanchored' });
  });
});

describe('resolveItem', () => {
  const row: Anchor = {
    key: itemKey('asset', 'a1b2'),
    props: {},
    enabled: true,
    publishes: { assetHash: 'a1b2' },
    editor: 'documents' as EditorId,
    via: { kind: 'dom', node },
  };

  it('finds the row that publishes a subject', () => {
    expect(resolveItem(live([row]), 'asset', 'a1b2')).toEqual({ state: 'ready', anchor: row });
  });

  it('is absent when nothing on screen names that subject', () => {
    expect(resolveItem(live([row]), 'asset', 'ffff')).toEqual({ state: 'absent' });
  });
});

describe('mapOf', () => {
  it('folds records naming the same command into one entry, without repeats', () => {
    const built = mapOf([
      { id: 'asset.accept', editor: 'asset' as EditorId },
      { id: 'asset.accept', editor: 'documents' as EditorId },
      { id: 'asset.accept', editor: 'asset' as EditorId, when: 'kind=portrait' },
    ]);
    expect(built.editorsFor['asset.accept']).toEqual(['asset', 'documents']);
  });
});
