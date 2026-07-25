import { synthProject, synthScript } from '../index.js';

describe('synthScript', () => {
  it('is a pure function of its options', () => {
    const opts = { scenes: 7, fanout: 2, characters: 3, locations: 2 };
    expect(synthScript(opts)).toBe(synthScript(opts));
  });

  it('roots a reachable tree at s0 and dangles no goto', () => {
    const script = synthScript({ scenes: 6, fanout: 2 });
    const declared = [...script.matchAll(/\[\[scene: (\w+)\]\]/g)].map((m) => m[1]!);
    const targets = [...script.matchAll(/-> (\w+)\]\]|\[\[next: (\w+)\]\]/g)].map(
      (m) => m[1] ?? m[2]!,
    );
    expect(declared).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(new Set(targets)).toEqual(new Set(['s1', 's2', 's3', 's4', 's5']));
  });

  it('emits a linear chain at fanout 1 and choices above it', () => {
    expect(synthScript({ scenes: 3, fanout: 1 })).toContain('[[next: s1]]');
    expect(synthScript({ scenes: 3, fanout: 1 })).not.toContain('[[choice:');
    expect(synthScript({ scenes: 3, fanout: 2 })).toContain('[[choice: To scene 1 -> s1]]');
  });

  it('rejects degenerate sizes', () => {
    expect(() => synthScript({ scenes: 0 })).toThrow(/at least one scene/);
    expect(() => synthScript({ fanout: 0 })).toThrow(/fanout of at least 1/);
  });
});

describe('synthProject', () => {
  /** Run to completion: once past the gate the scheduler replans until nothing is ready. */
  async function runOut(p: Awaited<ReturnType<typeof synthProject>>) {
    await p.run();
    await p.approveAll();
    return p.run();
  }

  it('pins the scenes-to-tasks ratio at L + 4C + 2N', async () => {
    const scenes = 6;
    const characters = 2;
    const locations = 3;
    const p = await synthProject({ scenes, characters, locations, title: 'Scale' });
    try {
      const summary = await runOut(p);
      expect(summary.blockedOnGate).toBe(false);

      const { graph } = await p.reload();
      const all = graph.all();
      const byKind = (kind: string) => all.filter((t) => t.kind === kind).length;
      // One establishing shot per scene plus one per speaking character; portraits and
      // location plates are shared, so scenes are not nodes.
      expect(byKind('location_ref')).toBe(locations);
      expect(byKind('portrait')).toBe(characters);
      expect(byKind('model_sheet')).toBe(characters * 3);
      expect(byKind('shot_image')).toBe(scenes * 2);
      expect(all).toHaveLength(locations + 4 * characters + 2 * scenes);
      expect(all.every((t) => t.status === 'done')).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 60_000);

  it('produces the same task identities from two independent builds', async () => {
    const opts = { scenes: 3, fanout: 1, characters: 1, locations: 1, title: 'Determinism' };
    const [a, b] = [await synthProject(opts), await synthProject(opts)];
    try {
      await runOut(a);
      await runOut(b);
      const hashes = async (p: typeof a) =>
        (await p.reload()).graph
          .all()
          .map((t) => t.hash)
          .sort();
      expect(await hashes(a)).toEqual(await hashes(b));
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 60_000);
});
