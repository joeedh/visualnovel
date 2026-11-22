/**
 * Tests each stills slot kind's `fromInputs` through the solver's `taskSlot`. It checks which kind
 * fills a task of each kind, the retired `outfit_sheet` included, and the binding the task's
 * inputs name. The addresses these bindings make are pinned in `@vn/pipeline`'s
 * `slotoftask.test.ts`.
 */
import { taskSlot } from '@vn/constraint-solver';
import type { AnyTask, ProjectModel } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import {
  plateKind,
  portraitKind,
  sheetKind,
  shotKind,
  stillsFamily,
  type StillsFacts,
} from '../index.js';

/** Builds facts over a project whose one scene's storyboard holds `arrival__1`. */
function facts(): StillsFacts {
  const m: ProjectModel = model(
    [character('aiko')],
    [scene('arrival', ['aiko'], 'cafe')],
    [location('cafe')],
  );
  m.production.set('arrival', {
    shots: [
      {
        id         : 'arrival__1',
        sceneId    : 'arrival',
        framing    : 'wide',
        location   : 'day',
        subjects   : [],
        coversLines: [],
      },
    ],
  });
  return { model: m, tasks: { get: () => undefined } };
}

/** Builds a record of `kind` as the task log holds one, retired kinds included. */
const task = (kind: string, inputs: object): AnyTask =>
  ({
    hash: `h-${kind}`,
    kind,
    deps: [],
    inputs,
    status  : 'done',
    attempts: [],
  }) as unknown as AnyTask;

const sheet = { characterId: 'aiko', outfit: 'default', angle: 'back' };

describe('the stills kinds read a task back into its slot', () => {
  it('reads a plate task into its plate', () => {
    expect(
      taskSlot(stillsFamily, task('location_ref', { locationId: 'cafe', variant: 'day' }), facts()),
    ).toEqual({
      kind   : plateKind,
      binding: { kind: 'plate', locationId: 'cafe', variant: 'day' },
    });
  });

  it('reads a portrait task into its portrait', () => {
    expect(taskSlot(stillsFamily, task('portrait', { characterId: 'aiko' }), facts())).toEqual({
      kind   : portraitKind,
      binding: { kind: 'portrait', characterId: 'aiko' },
    });
  });

  it('reads a model sheet, and a retired outfit sheet, into the same sheet slot', () => {
    const binding = { kind: 'sheet', ...sheet };
    expect(taskSlot(stillsFamily, task('model_sheet', sheet), facts())).toEqual({
      kind: sheetKind,
      binding,
    });
    expect(taskSlot(stillsFamily, task('outfit_sheet', sheet), facts())).toEqual({
      kind: sheetKind,
      binding,
    });
    expect(sheetKind.retired).toEqual(['outfit_sheet']);
  });

  it('reads a shot task into its shot, finding the scene in the storyboards', () => {
    expect(taskSlot(stillsFamily, task('shot_image', { shotId: 'arrival__1' }), facts())).toEqual({
      kind   : shotKind,
      binding: { kind: 'shot', sceneId: 'arrival', shotId: 'arrival__1' },
    });
    expect(
      taskSlot(stillsFamily, task('shot_image', { shotId: 'arrival__2' }), facts()),
    ).toBeUndefined();
  });

  it('reads nothing from a retired kind no stills kind lists', () => {
    expect(taskSlot(stillsFamily, task('vision_review', { target: 'a' }), facts())).toBeUndefined();
    expect(
      taskSlot(stillsFamily, task('prompt_refine', { basePrompt: 'p' }), facts()),
    ).toBeUndefined();
  });
});
