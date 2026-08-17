/**
 * What an LLM decomposition is allowed to name. `coversLines` and `location` were already
 * checked against the scene; `characterId` was not, and the planner's answer to a subject it
 * cannot resolve is to skip the shot — permanently, since the decomposition is persisted. So
 * these cases are about the ids the model returns, not about the shots it chooses.
 */
import type { Character, ProjectModel, Providers, Scene } from '@vn/types';
import { decomposeScene } from '../p5.js';

const character = (id: string): Character => ({
  id,
  name: id,
  description: `${id} description`,
  traits: [],
  palette: [],
  status: 'approved',
  defaultOutfit: 'uniform',
  outfits: [{ id: 'uniform', characterId: id, description: 'school uniform' }],
  approvedPortrait: 'aaa',
});

const SCENE: Scene = {
  id: 'epilogue',
  location: 'classroom',
  characters: [],
  lines: [
    { id: 'epilogue:L1', kind: 'narration', text: 'Morning light finds the empty classroom.' },
    { id: 'epilogue:L2', kind: 'narration', text: 'Aiko pauses at the door, then smiles.' },
  ],
  choices: [],
  shots: [],
};

const MODEL: ProjectModel = {
  title: 'T',
  characters: new Map([['aiko', character('aiko')]]),
  locations: new Map([
    [
      'classroom',
      {
        id: 'classroom',
        name: 'Classroom 2-B',
        description: 'A classroom',
        palette: [],
        variants: [{ id: 'day', description: 'daylight' }],
        mined: false,
      },
    ],
  ]),
  scenes: new Map([['epilogue', SCENE]]),
  reachable: new Set(['epilogue']),
  entry: 'epilogue',
  diagnostics: [],
};

/** Providers whose only live method is `text.structured`, returning one canned decomposition. */
function providersReturning(shots: unknown[]): Providers {
  const raw = JSON.stringify({ shots });
  return {
    image: {} as Providers['image'],
    reviewers: [],
    text: {
      structured: <T>(_prompt: string, parse: (raw: string) => T): Promise<T> =>
        Promise.resolve(parse(raw)),
      complete: () => Promise.reject(new Error('decomposition does not use complete()')),
    },
  };
}

const shot = (subjects: unknown[]): Record<string, unknown> => ({
  id: 'S1',
  framing: 'medium',
  location: 'day',
  subjects,
  camera: 'framed in the doorway',
  coversLines: ['epilogue:L2'],
});

describe('decomposeScene subjects', () => {
  it('keeps a subject the model has', async () => {
    const { shots } = await decomposeScene(
      SCENE,
      MODEL,
      providersReturning([shot([{ characterId: 'aiko', outfit: 'uniform' }])]),
    );
    expect(shots[0]!.subjects.map((s) => s.characterId)).toEqual(['aiko']);
  });

  it('resolves the case the prose uses to the id the sheet has', async () => {
    const { shots } = await decomposeScene(
      SCENE,
      MODEL,
      providersReturning([shot([{ characterId: 'Aiko', outfit: 'uniform' }])]),
    );
    // Not merely accepted — rewritten, because the planner looks the id up verbatim.
    expect(shots[0]!.subjects.map((s) => s.characterId)).toEqual(['aiko']);
  });

  it('drops a character the project does not have, and keeps the shot', async () => {
    const { shots } = await decomposeScene(
      SCENE,
      MODEL,
      providersReturning([
        shot([
          { characterId: 'aiko', outfit: 'uniform' },
          { characterId: 'the_teacher', outfit: 'suit' },
        ]),
      ]),
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]!.subjects.map((s) => s.characterId)).toEqual(['aiko']);
  });

  it('carries pose and expression through the resolution, but never an outfit', async () => {
    const { shots } = await decomposeScene(
      SCENE,
      MODEL,
      providersReturning([
        shot([
          {
            characterId: 'Aiko',
            outfit: 'uniform',
            pose: 'pausing at the doorway',
            expression: 'gentle smile',
          },
        ]),
      ]),
    );
    // The outfit is dropped even though the model volunteered one — baking it here would shadow
    // the `[[outfit:]]` marker the author writes later.
    expect(shots[0]!.subjects[0]).toEqual({
      characterId: 'aiko',
      pose: 'pausing at the doorway',
      expression: 'gentle smile',
    });
  });
});
