import { isSelected, selectionForTask, taskIsSelected, type Selection } from '../selection.js';
import type { ImageParams } from '@vn/types';
import type { Task } from '../../../src/shared/ipc';

const PARAMS: ImageParams = { modelId: 'mock-image' };
const NONE: Selection = { sceneId: '', shotId: '', characterId: '' };

const task = (over: Partial<Task> & Pick<Task, 'hash' | 'kind' | 'inputs'>): Task => ({
  deps: [],
  status: 'pending',
  attempts: [],
  ...over,
});

const shot = (shotId: string): Task =>
  task({
    hash: `h:${shotId}`,
    kind: 'shot_image',
    inputs: { shotId, prompt: '', refs: [], params: PARAMS },
  });

const portrait = (characterId: string): Task =>
  task({
    hash: `h:${characterId}`,
    kind: 'portrait',
    inputs: { characterId, prompt: '', refs: [], params: PARAMS },
  });

const sheet = (characterId: string): Task =>
  task({
    hash: `sheet:${characterId}`,
    kind: 'model_sheet',
    inputs: {
      characterId,
      outfit: 'default',
      angle: 'front',
      prompt: '',
      refs: [],
      params: PARAMS,
    },
  });

const plate = (locationId: string): Task =>
  task({
    hash: `plate:${locationId}`,
    kind: 'location_ref',
    inputs: { locationId, variant: 'day', prompt: '', refs: [], params: PARAMS },
  });

const view = (t: Task): { kind: 'task'; id: string; task: Task; subject: string } => ({
  kind: 'task',
  id: t.hash,
  task: t,
  subject: '',
});

describe('selectionForTask', () => {
  it('names the shot and the scene the shot id is namespaced under', () => {
    expect(selectionForTask(shot('arrival__beat1'), NONE)).toEqual({
      sceneId: 'arrival',
      shotId: 'arrival__beat1',
      characterId: '',
    });
  });

  it('keeps the rest of the selection when it names a shot', () => {
    const current: Selection = { sceneId: 'x', shotId: 'x__1', characterId: 'aiko' };
    expect(selectionForTask(shot('greet__establishing'), current).characterId).toBe('aiko');
  });

  it('falls back to the whole id when a shot id carries no scene prefix', () => {
    expect(selectionForTask(shot('loose'), NONE).sceneId).toBe('loose');
  });

  it('names a character, leaving the scene and shot alone', () => {
    const current: Selection = { sceneId: 'arrival', shotId: 'arrival__1', characterId: '' };
    expect(selectionForTask(portrait('aiko'), current)).toEqual({
      sceneId: 'arrival',
      shotId: 'arrival__1',
      characterId: 'aiko',
    });
  });

  it('returns the same object for a task that names neither, so nothing is lost', () => {
    const current: Selection = { sceneId: 'arrival', shotId: 'arrival__1', characterId: 'aiko' };
    expect(selectionForTask(plate('school'), current)).toBe(current);
  });
});

describe('taskIsSelected', () => {
  it('answers for a bare task, which is what a list has', () => {
    const sel: Selection = { sceneId: 'arrival', shotId: 'arrival__beat1', characterId: 'aiko' };
    expect(taskIsSelected(shot('arrival__beat1'), sel)).toBe(true);
    expect(taskIsSelected(sheet('aiko'), sel)).toBe(true);
    expect(taskIsSelected(plate('school'), sel)).toBe(false);
  });
});

describe('isSelected', () => {
  it('matches a shot task against the selected shot', () => {
    const sel: Selection = { sceneId: 'arrival', shotId: 'arrival__beat1', characterId: '' };
    expect(isSelected(view(shot('arrival__beat1')), sel)).toBe(true);
    expect(isSelected(view(shot('arrival__beat2')), sel)).toBe(false);
  });

  it('lights every task about the selected character', () => {
    const sel: Selection = { ...NONE, characterId: 'aiko' };
    expect(isSelected(view(portrait('aiko')), sel)).toBe(true);
    expect(isSelected(view(sheet('aiko')), sel)).toBe(true);
    expect(isSelected(view(portrait('rin')), sel)).toBe(false);
  });

  it('selects nothing when the selection is empty', () => {
    expect(isSelected(view(portrait('aiko')), NONE)).toBe(false);
    expect(isSelected(view(shot('arrival__beat1')), NONE)).toBe(false);
  });

  it('never selects a task that names neither a shot nor a character', () => {
    expect(isSelected(view(plate('school')), { ...NONE, characterId: 'school' })).toBe(false);
  });

  it('never selects a ghost or the gate barrier', () => {
    const ghost = {
      kind: 'ghost' as const,
      id: 'ghost:shots:arrival',
      ghost: { id: 'ghost:shots:arrival', label: '', after: [], gated: true },
    };
    const barrier = { kind: 'barrier' as const, id: 'gate:barrier', pending: ['aiko'] };
    const sel: Selection = { sceneId: 'arrival', shotId: 'arrival__1', characterId: 'aiko' };
    expect(isSelected(ghost, sel)).toBe(false);
    expect(isSelected(barrier, sel)).toBe(false);
  });
});
