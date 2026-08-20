/**
 * The chunked-prompt baseline (`docs/plans/archive/chunked-prompts.md`, stage 0).
 *
 * Task identity is `sha256(kind, inputs)` over the *flat* prompt string, so any change to how a
 * prompt is assembled re-keys every task in every existing project. This pins the whole set for a
 * real fixture run: the literal below was recorded before chunking existed, and it must survive
 * the refactor character for character.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';

jest.setTimeout(60_000);

/** Every planned task, as `kind hash`, sorted — a stable projection of the whole graph. */
async function taskHashes(p: TestProject): Promise<string[]> {
  const { graph } = await p.reload();
  return graph
    .all()
    .map((t) => `${t.kind} ${t.hash}`)
    .sort();
}

// Recorded against a run with no override authored anywhere. Regenerating this literal is
// never the fix for a failure here — a diff means prompts moved.
const BASELINE = [
  'location_ref 336d09ed905d4352db239a19cf13aa3fc85c95d73f5758c1b69b0db6b1123d6b',
  'location_ref 54b6681d8a620cb62480a6e2558c61124ec5302aaa99e7bcdb7d16e3b480ab38',
  'model_sheet 298a2b83f0763969eb7ffc84e2f789cba72cbe83997d34b76a7d69997f7503d1',
  'model_sheet 9075b2cf4e4af81eacbb42861498de2acaa8d2304e391d58f13b01bd3e6ae7ff',
  'model_sheet ea377ace1857f70214f6c658bc899d8dac849de81879012192e0763b5534dfd9',
  'portrait b4a6626010807bd563c84f04339090abb08f1868107dc625e4153b4a463aad2c',
  'shot_image 51c8efab07cdc174937535ae0b3d810a558bb0372efdb818b2d746364d1865e0',
  'shot_image 5565fd82f6a88e43e415dec48a53b4750be928eeacb64a77f3caefd7c0f727c3',
  'shot_image 77468de49d1d806b3919803537e48b79ba609c5a1d610f004312b92dff1649b2',
];

describe('prompt hash baseline', () => {
  it('keeps every task hash a fixture run produces', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run();
      expect(await taskHashes(p)).toEqual(BASELINE);
    } finally {
      await p.cleanup();
    }
  });

  // The other half of the acceptance test: an override is not inert. Authoring one has to move
  // the task it names — and nothing else, since every other prompt is composed from chunks no
  // override touched.
  it('moves exactly the task an authored override names', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run();
      const before = await taskHashes(p);

      const { model } = await p.reload();
      const sceneId = [...model.scenes.keys()][0]!;
      const rel = `vngen/work/shots/${sceneId}.json`;
      const file = JSON.parse(await p.read(rel));
      file.shots[0].promptOverride = {
        mode: 'chunks',
        mute: ['camera'],
        replace: { subject: 'Seen from behind.' },
      };
      await p.write(rel, JSON.stringify(file, null, 2) + '\n');
      await p.run();

      const after = await taskHashes(p);
      const added = after.filter((h) => !before.includes(h));
      // Nothing disappears: `tasks.jsonl` keeps the superseded node, which is what makes the
      // "one task moved" claim checkable at all.
      expect(before.filter((h) => !after.includes(h))).toEqual([]);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/^shot_image /);
    } finally {
      await p.cleanup();
    }
  });

  // Derived-first is not a preference: `canonicalJson` maps arrays positionally, so appending is
  // the only order under which a project authoring no references keeps every hash it had.
  it('appends an authored reference after everything the planner derived', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run();

      const { model } = await p.reload();
      const sceneId = [...model.scenes.keys()][0]!;
      const rel = `vngen/work/shots/${sceneId}.json`;
      const file = JSON.parse(await p.read(rel));
      const shotId: string = file.shots[0].id;
      const refsOf = async (): Promise<{ hash: string; ext: string }[][]> =>
        (await p.reload()).graph
          .all()
          .filter(
            (t) => t.kind === 'shot_image' && (t.inputs as { shotId: string }).shotId === shotId,
          )
          .map((t) => (t.inputs as { refs: { hash: string; ext: string }[] }).refs);

      const derived = (await refsOf())[0]!;
      expect(derived.length).toBeGreaterThan(0);

      // Pin an asset that already exists, so the run has real bytes to hand the mock provider.
      const pin = [...model.characters.values()][0]!.approvedPortrait!;
      file.shots[0].promptOverride = { mode: 'chunks', refs: { style: [{ pin, ext: 'png' }] } };
      await p.write(rel, JSON.stringify(file, null, 2) + '\n');
      await p.run();

      const after = (await refsOf()).find((refs) => refs.length === derived.length + 1)!;
      expect(after.slice(0, derived.length)).toEqual(derived);
      expect(after[derived.length]).toEqual({ hash: pin, ext: 'png' });
    } finally {
      await p.cleanup();
    }
  });
});
