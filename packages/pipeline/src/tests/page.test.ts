/**
 * A page shot through the real scheduler: the layout verdict the runner draws from the boxes a
 * reviewer measured, and the boxes the planner records beside the page's image. Driven end to
 * end because both live at the seam between a review and the shots file.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { DefectReport, Shot, ShotsFile } from '@vn/types';
import { layoutReport } from '../runners.js';

const FILE = 'vngen/work/shots/arrival.json';

jest.setTimeout(60_000);

const PAGE = {
  version: 1,
  scene  : 'arrival',
  shots: [
    {
      id         : 'arrival__page1',
      sceneId    : 'arrival',
      framing    : 'wide',
      location   : 'day',
      subjects   : [{ characterId: 'aiko' }],
      panels: [
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 0.5],
            [0, 0.5],
          ],
          framing    : 'wide',
          subjects   : [],
          coversLines: ['arrival:L1'],
        },
        {
          shape: [
            [0, 0.5],
            [1, 0.5],
            [1, 1],
            [0, 1],
          ],
          framing    : 'close',
          subjects   : [{ characterId: 'aiko' }],
          coversLines: ['arrival:L2'],
        },
      ],
      coversLines: ['arrival:L1', 'arrival:L2'],
    },
  ],
};

/** A clean review that also measured the page. */
const seeing = (boxes: { x: number; y: number; w: number; h: number }[]): string =>
  JSON.stringify({
    reviewer: 'r',
    defects : [],
    observed: { panels: boxes.map((box) => ({ box })) },
  });

const TWO_TIERS = [
  { x: 0, y: 0, w: 1, h: 0.5 },
  { x: 0, y: 0.5, w: 1, h: 0.5 },
];

async function pageProject(): Promise<TestProject> {
  const p = await makeProject({
    script: SCRIPTS.linear,
    config: { max_refine_attempts: 2 },
  });
  await p.write(FILE, JSON.stringify(PAGE, null, 2) + '\n');
  await p.run();
  await p.approveAll();
  return p;
}

async function pageShot(p: TestProject): Promise<ShotsFile['shots'][number]> {
  const file = JSON.parse(await p.read(FILE)) as ShotsFile;
  return file.shots.find((s) => s.id === 'arrival__page1')!;
}

describe('a page shot through the pipeline', () => {
  it('accepts a page whose measured boxes match its panels, and records them beside the image', async () => {
    const p = await pageProject();
    try {
      await p.run({ reviewResponses: [seeing(TWO_TIERS)] });
      const shot = await pageShot(p);
      expect(shot.shotData?.status).toBe('accepted');
      expect(shot.shotData?.panelBoxes).toEqual(TWO_TIERS);
      // The page was drawn at the project's page ratio, not the frame ratio
      const { graph } = await p.reload();
      const task = graph
        .all()
        .find((t) => (t.inputs as { shotId?: string }).shotId === 'arrival__page1')!;
      expect((task.inputs as { params: { aspect: string } }).params.aspect).toBe('3:4');
    } finally {
      await p.cleanup();
    }
  });

  it('files a blocking layout defect from the boxes, attributed to `layout`, when they do not match', async () => {
    const p = await pageProject();
    try {
      // One box where two panels were meant, every attempt
      await p.run({ reviewResponses: [seeing([{ x: 0, y: 0, w: 1, h: 1 }])] });
      const shot = await pageShot(p);
      expect(shot.shotData?.status).toBe('needs_human');
      const { graph } = await p.reload();
      const task = graph
        .all()
        .find((t) => (t.inputs as { shotId?: string }).shotId === 'arrival__page1')!;
      const reports = task.attempts[0]!.reviews as { reviewer: string; defects: unknown[] }[];
      expect(reports.map((r) => r.reviewer)).toEqual(['gemini', 'claude', 'layout']);
      expect(reports[2]!.defects).toEqual([
        expect.objectContaining({ severity: 'blocking', category: 'layout' }),
      ]);
    } finally {
      await p.cleanup();
    }
  });

  it('draws no verdict when no reviewer measured the page', async () => {
    const p = await pageProject();
    try {
      await p.run();
      const shot = await pageShot(p);
      expect(shot.shotData?.status).toBe('accepted');
      expect(shot.shotData?.panelBoxes).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });
});

describe('the layout verdict over several measurements', () => {
  const shot = PAGE.shots[0] as unknown as Shot;
  const report = (boxes: { x: number; y: number; w: number; h: number }[]): DefectReport => ({
    reviewer: 'r',
    defects : [],
    observed: { panels: boxes.map((box) => ({ box })) },
  });
  // A page measured against its width rather than its height, as one reviewer did in the
  // Stage 2 live check: every box sits in the top three quarters
  const squashed = [
    { x: 0, y: 0, w: 1, h: 0.37 },
    { x: 0, y: 0.37, w: 1, h: 0.37 },
  ];

  it('trusts a match from any measuring reviewer over a miss from another', () => {
    const [verdict] = layoutReport(shot, [report(squashed), report(TWO_TIERS)]);
    expect(verdict).toEqual({ reviewer: 'layout', defects: [] });
    expect(layoutReport(shot, [report(TWO_TIERS), report(squashed)])[0]!.defects).toEqual([]);
  });

  it('files the first miss when no measurement matches', () => {
    const [verdict] = layoutReport(shot, [report(squashed), report([{ x: 0, y: 0, w: 1, h: 1 }])]);
    expect(verdict!.defects).toEqual([
      expect.objectContaining({ severity: 'blocking', category: 'layout' }),
    ]);
  });
});
