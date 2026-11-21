/**
 * `slotOfTask` reads a task back into the address of the slot it fills. Every address below is
 * the one `graphrun.ts`'s switch on task kind names answered when this test was written, so the
 * cases show that moving the lookup onto the stills family's slot kinds changed no answer.
 */
import { projectConfig, type AnyTask, type ProjectModel } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { slotOfTask, waveFacts } from '../index.js';

const config = projectConfig.parse({ title: 'Test' });

/** Builds a project with Aiko in one scene at the cafe, whose storyboard holds one shot. */
function project(): ProjectModel {
  const m = model([character('aiko')], [scene('arrival', ['aiko'], 'cafe')], [location('cafe')]);
  m.production.set('arrival', {
    shots: [
      {
        id         : 'arrival__1',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : 'day',
        subjects   : [],
        coversLines: [],
      },
    ],
  });
  return m;
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

/** Answers the address of the slot `t` fills in `m`. */
const keyOf = (t: AnyTask, m: ProjectModel = project()): string | undefined =>
  slotOfTask(t, waveFacts({ model: m, config }));

const drawn = { prompt: 'p', refs: [], params: { modelId: 'mock-image' } };

describe('slotOfTask', () => {
  it('reads each kind the stills family plans into its slot address', () => {
    expect(keyOf(task('portrait', { characterId: 'aiko', ...drawn }))).toBe('portrait:aiko');
    expect(keyOf(task('location_ref', { locationId: 'cafe', variant: 'night', ...drawn }))).toBe(
      'plate:cafe/night',
    );
    expect(
      keyOf(
        task('model_sheet', { characterId: 'aiko', outfit: 'default', angle: 'front', ...drawn }),
      ),
    ).toBe('sheet:aiko/default/front');
    expect(keyOf(task('shot_image', { shotId: 'arrival__1', ...drawn }))).toBe(
      'shot:arrival/arrival__1',
    );
  });

  it('files a retired outfit_sheet record under the sheet slot a model sheet fills', () => {
    const inputs = { characterId: 'aiko', outfit: 'default', angle: 'side', ...drawn };
    expect(keyOf(task('outfit_sheet', inputs))).toBe('sheet:aiko/default/side');
  });

  it('answers no slot for a retired kind no slot kind takes', () => {
    expect(keyOf(task('vision_review', { target: 'a1', spec: 's', refs: [] }))).toBeUndefined();
    expect(keyOf(task('prompt_refine', { basePrompt: 'p', defects: 'd' }))).toBeUndefined();
  });

  it('answers no slot when the inputs lack a field the address needs', () => {
    expect(keyOf(task('portrait', drawn))).toBeUndefined();
    expect(keyOf(task('location_ref', { locationId: 'cafe', ...drawn }))).toBeUndefined();
    expect(
      keyOf(task('model_sheet', { characterId: 'aiko', outfit: 'default', ...drawn })),
    ).toBeUndefined();
    expect(keyOf(task('outfit_sheet', { characterId: 'aiko', angle: 'front' }))).toBeUndefined();
    expect(keyOf(task('shot_image', drawn))).toBeUndefined();
  });

  it('reads an empty field as a missing one', () => {
    expect(keyOf(task('portrait', { characterId: '', ...drawn }))).toBeUndefined();
    expect(
      keyOf(task('location_ref', { locationId: '', variant: 'day', ...drawn })),
    ).toBeUndefined();
    expect(
      keyOf(task('location_ref', { locationId: 'cafe', variant: '', ...drawn })),
    ).toBeUndefined();
    const sheet = { characterId: 'aiko', outfit: 'default', angle: 'front', ...drawn };
    expect(keyOf(task('model_sheet', { ...sheet, characterId: '' }))).toBeUndefined();
    expect(keyOf(task('model_sheet', { ...sheet, outfit: '' }))).toBeUndefined();
    expect(keyOf(task('outfit_sheet', { ...sheet, angle: '' }))).toBeUndefined();
    expect(keyOf(task('shot_image', { shotId: '', ...drawn }))).toBeUndefined();
  });

  it('answers no slot for a shot no storyboard in the model holds', () => {
    expect(keyOf(task('shot_image', { shotId: 'arrival__9', ...drawn }))).toBeUndefined();
    const bare = model(
      [character('aiko')],
      [scene('arrival', ['aiko'], 'cafe')],
      [location('cafe')],
    );
    expect(keyOf(task('shot_image', { shotId: 'arrival__1', ...drawn }), bare)).toBeUndefined();
  });
});
