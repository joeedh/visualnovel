/**
 * Batch decomposition, run on real projects. The contract under test is what ends up on disk, and
 * a hand-built model would prove nothing about a file that is preferred forever once it exists.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { createMockProviders } from '@vn/providers';
import type { Providers } from '@vn/types';
import { decomposeAll, decomposeAllPreview } from '../decompose.js';

jest.setTimeout(30_000);

/**
 * A text LLM that answers every scene with one shot covering all of its lines. Built from the
 * prompt rather than canned, because `coversLines` is checked against the scene it came from — a
 * fixed reply would bind nothing in the second scene and silently become a baseline.
 */
function answering(): Providers {
  const providers = createMockProviders();
  providers.text = {
    complete  : () => Promise.resolve(''),
    structured: (prompt, parse) => {
      const lines = [...prompt.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      return Promise.resolve(
        parse(
          JSON.stringify({
            shots: [
              { id: 'only', framing: 'medium', location: 'day', subjects: [], coversLines: lines },
            ],
          }),
        ),
      );
    },
  };
  return providers;
}

const shotsOf = (p: TestProject, scene: string) => p.read(`vngen/work/shots/${scene}.json`);

const missing = async (p: TestProject, scene: string): Promise<boolean> =>
  shotsOf(p, scene).then(
    () => false,
    () => true,
  );

describe('decomposeAll', () => {
  it('writes a storyboard for every reachable scene, and none for the one nothing points at', async () => {
    const p = await makeProject({ script: SCRIPTS.orphan });
    try {
      const { model } = await p.reload();
      const result = await decomposeAll({ model, providers: answering(), paths: p.paths });

      expect(result.decomposed.sort()).toEqual(['arrival', 'rooftop']);
      expect(result.fellBack).toEqual([]);
      // A dead branch costs a model call and renders nothing, so it is never asked for.
      expect(result.kept).toEqual([]);
      expect(await missing(p, 'forgotten')).toBe(true);
      expect(JSON.parse(await shotsOf(p, 'arrival')).shots).toHaveLength(1);
    } finally {
      await p.cleanup();
    }
  });

  it('writes nothing when the model does not answer, and names every scene it did not write', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { model } = await p.reload();
      // The default mock text LLM echoes the prompt, which no schema accepts — the same shape a
      // real run with a bad key has.
      const result = await decomposeAll({
        model,
        providers: createMockProviders(),
        paths    : p.paths,
      });

      expect(result.fellBack.map((f) => f.scene).sort()).toEqual(['arrival', 'rooftop']);
      expect(result.fellBack[0]!.reason).toBeTruthy();
      expect(result.decomposed).toEqual([]);
      // Nothing on disk: an absent file is the only signal that means "decompose this scene", so
      // a baseline written here would be permanent.
      expect(await missing(p, 'arrival')).toBe(true);
      expect(await missing(p, 'rooftop')).toBe(true);
    } finally {
      await p.cleanup();
    }
  });

  it('writes the baseline only when a caller asks for it by name', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { model } = await p.reload();
      const result = await decomposeAll({
        model,
        providers   : createMockProviders(),
        paths       : p.paths,
        keepBaseline: true,
      });

      expect(result.decomposed.sort()).toEqual(['arrival', 'rooftop']);
      expect(result.fellBack).toEqual([]);
      expect(JSON.parse(await shotsOf(p, 'arrival')).shots.length).toBeGreaterThan(0);
    } finally {
      await p.cleanup();
    }
  });

  it('keeps what is already decomposed, spending nothing and leaving the tree clean', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { model } = await p.reload();
      await decomposeAll({ model, providers: answering(), paths: p.paths });
      const before = await shotsOf(p, 'arrival');

      // This provider throws if it is reached. Keeping must cost nothing, not merely be idempotent
      // on disk: re-decomposing would change shot ids and re-render paid-for art.
      const forbidden = createMockProviders();
      forbidden.text.structured = () => Promise.reject(new Error('should not have been asked'));
      const again = await decomposeAll({ model, providers: forbidden, paths: p.paths });

      expect(again.kept.sort()).toEqual(['arrival', 'rooftop']);
      expect(again.decomposed).toEqual([]);
      expect(await shotsOf(p, 'arrival')).toBe(before);
    } finally {
      await p.cleanup();
    }
  });

  it('names a file it cannot read and carries on with the rest', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.write('vngen/work/shots/arrival.json', '{ not json');
      const { model } = await p.reload();
      const result = await decomposeAll({ model, providers: answering(), paths: p.paths });

      expect(result.unreadable.map((u) => u.scene)).toEqual(['arrival']);
      expect(result.unreadable[0]!.error).toContain('arrival');
      // The file is left exactly as it is. Re-decomposing over what may be a hand-edit would make
      // the file untrustworthy to edit.
      expect(await shotsOf(p, 'arrival')).toBe('{ not json');
      expect(result.decomposed).toEqual(['rooftop']);
    } finally {
      await p.cleanup();
    }
  });
});

describe('decomposeAllPreview', () => {
  it('says what a run would cost without asking the model anything', async () => {
    const p = await makeProject({ script: SCRIPTS.orphan });
    try {
      const { model } = await p.reload();
      expect(await decomposeAllPreview(model, p.paths)).toEqual({
        pending   : ['arrival', 'rooftop'],
        kept      : [],
        unreadable: [],
        atRisk    : [],
      });

      await decomposeAll({ model, providers: answering(), paths: p.paths });
      const after = await decomposeAllPreview(model, p.paths);
      expect(after.pending).toEqual([]);
      expect(after.kept.sort()).toEqual(['arrival', 'rooftop']);
    } finally {
      await p.cleanup();
    }
  });

  it('flags a scene whose cast the project does not have yet, since the omission is permanent', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, characters: [] });
    try {
      const { model } = await p.reload();
      const preview = await decomposeAllPreview(model, p.paths);
      // `resolveSubject` drops a character the model has never heard of, and the decomposition is
      // then frozen — so the warning has to arrive before the money is spent, not after.
      expect(preview.atRisk).toContain('arrival');
    } finally {
      await p.cleanup();
    }
  });
});
