/**
 * Which invocation a ringed anchor is checked with.
 *
 * The cases that matter are the partial ones: `stack.check` coerces before it reaches a command's
 * precondition, so a missing required prop answers about the blank instead of about the project.
 */
import { askedAs, checkFor } from '../precheck.js';
import { commandKey, itemKey, type Anchor } from '../anchors.js';
import type { CatalogProp } from '../../../src/shared/ipc.js';
import type { EditorId } from '../../../src/shared/editors.js';

const node = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
};

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  key: commandKey('gate.approve'),
  id: 'gate.approve',
  props: { characterId: 'aiko' },
  enabled: true,
  editor: 'taskgraph' as EditorId,
  via: { kind: 'dom', node },
  ...over,
});

const spec = (name: string, over: Partial<CatalogProp> = {}): CatalogProp => ({
  name,
  kind: 'string',
  description: name,
  required: true,
  ...over,
});

describe('checkFor', () => {
  it('fills a required string the widget has not answered yet', () => {
    expect(checkFor(anchor(), [spec('characterId'), spec('hash')])).toEqual({
      id: 'gate.approve',
      props: { characterId: 'aiko', hash: '' },
    });
  });

  it('leaves the props the anchor already recorded alone', () => {
    const drawn = anchor({ props: { characterId: 'aiko', hash: 'a1b2' } });
    expect(checkFor(drawn, [spec('characterId'), spec('hash')])?.props).toEqual({
      characterId: 'aiko',
      hash: 'a1b2',
    });
  });

  it('ignores an optional prop, which coercion fills from its default', () => {
    const props = [spec('characterId'), spec('note', { required: false, default: '' })];
    expect(checkFor(anchor(), props)?.props).toEqual({ characterId: 'aiko' });
  });

  it('blanks a list with a list, never with an empty string', () => {
    expect(checkFor(anchor(), [spec('characterId'), spec('tags', { kind: 'string[]' })])).toEqual({
      id: 'gate.approve',
      props: { characterId: 'aiko', tags: [] },
    });
  });

  /** A number has no unanswered value, so filling one in would be inventing an answer. */
  it('declines where a required prop cannot be blanked', () => {
    expect(
      checkFor(anchor(), [spec('characterId'), spec('count', { kind: 'number' })]),
    ).toBeUndefined();
  });

  it('declines a secret rather than sending a blank one', () => {
    expect(
      checkFor(anchor(), [spec('characterId'), spec('key', { kind: 'secret' })]),
    ).toBeUndefined();
  });

  it('answers nothing for a row that publishes a subject rather than running a command', () => {
    const row = anchor({ key: itemKey('scene', 'greet'), props: {} });
    delete (row as { id?: string }).id;
    expect(checkFor(row, [])).toBeUndefined();
  });
});

describe('askedAs', () => {
  it('reads the same for two invocations that differ only in prop order', () => {
    const one = askedAs({ id: 'gate.approve', props: { characterId: 'aiko', hash: '' } });
    const two = askedAs({ id: 'gate.approve', props: { hash: '', characterId: 'aiko' } });
    expect(one).toBe(two);
  });

  it('reads differently once a prop changes', () => {
    const one = askedAs({ id: 'gate.approve', props: { characterId: 'aiko' } });
    const two = askedAs({ id: 'gate.approve', props: { characterId: 'haruki' } });
    expect(one).not.toBe(two);
  });
});
