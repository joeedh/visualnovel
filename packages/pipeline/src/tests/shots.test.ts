/**
 * Shot persistence (`work/shots/<sceneId>.json`) driven through the real scheduler, because
 * the contracts under test are about what survives a process boundary — a hand-built model
 * would prove nothing.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { ShotsFile } from '@vn/types';

const FILE = 'vngen/work/shots/arrival.json';

// Each case builds a project and drives two full scheduler passes over mock providers.
jest.setTimeout(30_000);

/** Run → approve → run: the two passes it takes to get past the character gate. */
async function runPastGate(p: TestProject): Promise<void> {
  await p.run();
  await p.approveAll();
  await p.run();
}

async function shotsFile(p: TestProject): Promise<ShotsFile> {
  return JSON.parse(await p.read(FILE)) as ShotsFile;
}

async function shotHashes(p: TestProject): Promise<string[]> {
  const { graph } = await p.reload();
  return graph
    .all()
    .filter((t) => t.kind === 'shot_image')
    .map((t) => t.hash)
    .sort();
}

describe('persisted shot decompositions', () => {
  it('writes the decomposition, then refreshes shotData from what the run produced', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await runPastGate(p);

      const file = await shotsFile(p);
      expect(file.version).toBe(1);
      expect(file.scene).toBe('arrival');
      expect(file.shots.length).toBeGreaterThan(0);

      const { store } = await p.reload();
      for (const shot of file.shots) {
        expect(shot.sceneId).toBe('arrival');
        expect(shot.shotData?.status).toBe('accepted');
        // The manifest stays the authority for the bytes; this is a readable copy of the ref.
        expect(store.has(shot.shotData!.image!)).toBe(true);
      }
    } finally {
      await p.cleanup();
    }
  });

  it('reuses the persisted decomposition, so a second run is byte-identical and re-hashes nothing', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await runPastGate(p);
      const before = await p.read(FILE);
      const hashesBefore = await shotHashes(p);

      await p.run();

      expect(await p.read(FILE)).toBe(before);
      expect(await shotHashes(p)).toEqual(hashesBefore);
    } finally {
      await p.cleanup();
    }
  });

  it('honors a hand-written decomposition without letting its shotData claim work is done', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const handwritten = {
        version: 1,
        scene: 'arrival',
        shots: [
          {
            id: 'arrival__handwritten',
            sceneId: 'arrival',
            framing: 'establishing',
            location: 'day',
            subjects: [],
            coversLines: [],
            shotData: { image: 'not-a-real-hash', status: 'accepted' },
          },
        ],
      };
      await p.write(FILE, JSON.stringify(handwritten, null, 2) + '\n');

      await runPastGate(p);

      const { graph } = await p.reload();
      const shotIds = graph
        .all()
        .filter((t) => t.kind === 'shot_image')
        .map((t) => (t.inputs as { shotId: string }).shotId);
      // The authored half was used verbatim — the planner never re-decomposed over it.
      expect(shotIds.filter((id) => id.startsWith('arrival'))).toEqual(['arrival__handwritten']);

      const task = graph
        .all()
        .find((t) => (t.inputs as { shotId?: string }).shotId === 'arrival__handwritten')!;
      expect(task.status).toBe('done');

      // The stale `accepted` did not stop the work; the file now records what actually ran.
      const persisted = (await shotsFile(p)).shots[0]!;
      expect(persisted.shotData?.image).toBe(task.output);
      expect(persisted.shotData?.image).not.toBe('not-a-real-hash');
    } finally {
      await p.cleanup();
    }
  });

  it('drops line ids the screenplay no longer has, and that edit rehashes nothing', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await runPastGate(p);
      const hashesBefore = await shotHashes(p);

      const file = await shotsFile(p);
      file.shots[0]!.coversLines = [...file.shots[0]!.coversLines, 'arrival:L99'];
      await p.write(FILE, JSON.stringify(file, null, 2) + '\n');

      await p.run();

      const after = await shotsFile(p);
      expect(after.shots[0]!.coversLines).not.toContain('arrival:L99');
      // `buildShotPrompt` does not read `coversLines`, so coverage edits are free.
      expect(await shotHashes(p)).toEqual(hashesBefore);
    } finally {
      await p.cleanup();
    }
  });

  it('a dry run reads persisted shots but never writes a mock decomposition', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      await p.approveAll();
      await p.run({ dryRun: true });
      await expect(p.read(FILE)).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });
});
