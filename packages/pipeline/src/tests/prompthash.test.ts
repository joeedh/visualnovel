/**
 * The chunked-prompt baseline (`docs/plans/archive/INDEX.md#chunked-prompts`, stage 0).
 *
 * Task identity is `sha256(kind, inputs)` over the flat prompt string, so any change to how a
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

// Recorded against a run with no authored override. Regenerating this literal is never the fix
// for a failure here; a diff means prompts moved. Re-recorded once, on 2026-09-16, when the model
// id left the task identity (`identityOf` in `@vn/taskgraph`): the prompts were unchanged.
const BASELINE = [
  'location_ref b339a1bbff4b3d6a13f8f129e900714f208d977e791cdfeb7500328ac3e28fd1',
  'location_ref d8736c2a963bf4353c3a12a2bd40dd3a568f9b0716039c7097856395b323baac',
  'model_sheet 13191e3134647a767e700dc2fdbbf837d99836ec87b4ae900d2102920b4e2636',
  'model_sheet 7f850f038a1b98345da87a8fe6350448fedad9fe513d8cfca63256c8aeee74b8',
  'model_sheet a4bd4512b5da9e8ec88f1df5053a265caaf31c7bae20b9e9a037e32c64bed6be',
  'portrait faab8e6e7bc14f8616c961ca9898d0eb36b8de6bfb872b069d9710a5cfce52a6',
  'shot_image 1ef72cc0ff3339cee84419bd83243e050e26bc19acb20b1a1b91c21c29137595',
  'shot_image 86ec9bdf157dcac7fd40d7070385c94258b4da6f90f0b68f6dcc98c83e97ef1d',
  'shot_image f73e58a028e1d79049be4f7ef7059f2131e61230b5a83427b35b38bf2baf9d8f',
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

  // The other half of the acceptance test is that an override is not inert. Authoring one has to
  // move the task it names and nothing else, since every other prompt is composed from chunks no
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
        mode   : 'chunks',
        mute   : ['camera'],
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

  // `canonicalJson` maps arrays positionally, so appending after the derived refs is the only
  // order under which a project authoring no references keeps every hash it had.
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
