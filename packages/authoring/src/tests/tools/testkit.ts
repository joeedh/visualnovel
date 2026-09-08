import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import type { ConceptRequest, DescribeRequest, RedrawRequest } from '@vn/artgen';
import {
  createRegistry,
  Workspace,
  type ArtGen,
  type ConceptListing,
  type Tool,
  type ToolContext,
} from '../../index.js';

export const CHARACTER = `---
id: aiko
name: Aiko
status: draft
default_outfit: uniform
palette: ['#1a2a44']
traits: [curious]
---

Aiko is a transfer student.
`;

export const LOCATION = `---
id: classroom
name: Classroom 2-B
variants: [day, afternoon]
---

A second-floor classroom.
`;

/** One `scenes/<id>.md` per scene — a fork, its two arms, and the rejoin they share. */
export const CHUNKS: Record<string, string> = {
  arrival: `---
scene: arrival
---

INT. CLASSROOM - AFTERNOON

[[choice: Greet -> greet]]
[[choice: Observe -> observe]]

AIKO
Hello.
`,
  greet  : '---\nscene: greet\n---\n\nINT. CLASSROOM - AFTERNOON\n\n[[next: ending]]\n',
  observe: '---\nscene: observe\n---\n\nINT. CLASSROOM - EVENING\n\n[[next: ending]]\n',
  // Three lines, so it can hold two shots and therefore an order worth changing.
  ending: `---
scene: ending
---

INT. CLASSROOM - EVENING

The end.

AIKO
Goodbye.

She leaves.
`,
};

export async function tempProject(): Promise<{
  ctx: ToolContext;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-tools-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'locations'), { recursive: true });
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  await fs.writeFile(join(dir, 'characters', 'aiko', 'character.md'), CHARACTER);
  await fs.writeFile(join(dir, 'locations', 'classroom.md'), LOCATION);
  for (const [id, text] of Object.entries(CHUNKS)) {
    await fs.writeFile(join(dir, 'scenes', `${id}.md`), text);
  }
  // A directory has no document order, so the entry scene has to be named.
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\nstart: arrival\n');
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  return { ctx, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export const registry = createRegistry();
export function tool(name: string): Tool {
  const t = registry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
export const run = (name: string, args: unknown, ctx: ToolContext) =>
  tool(name).run(tool(name).args.parse(args), ctx);

/** Records what each art call asked for rather than drawing a picture. */
export function fakeArt(dir: string): {
  art: ArtGen;
  asked: ConceptRequest[];
  redrawn: RedrawRequest[];
  /** The concepts `list_images` and `edit_image`'s prefix resolver see; empty until pushed to. */
  concepts: ConceptListing[];
  /** What `view_image` asked to look at. */
  looked: DescribeRequest[];
} {
  const asked: ConceptRequest[] = [];
  const redrawn: RedrawRequest[] = [];
  const concepts: ConceptListing[] = [];
  const looked: DescribeRequest[] = [];
  const objectFile = (hash: string): string => join(dir, 'assets', 'objects', `${hash}.png`);
  const art: ArtGen = {
    preview : (req) => Promise.resolve({ prompt: `PROMPT ${req.sentence}` }),
    generate: (req) => {
      asked.push(req);
      return Promise.resolve({
        ref: { hash: 'f'.repeat(64), ext: 'png' },
        ...(req.subject ? { subject: req.subject } : {}),
        prompt: `PROMPT ${req.sentence}`,
        file  : objectFile('f'.repeat(64)),
      });
    },
    list    : () => Promise.resolve(concepts),
    redraw: (req) => {
      redrawn.push(req);
      return Promise.resolve({
        ref      : { hash: 'a'.repeat(64), ext: 'png' },
        prompt   : req.prompt ?? 'THE RECORDED PROMPT',
        file     : objectFile('a'.repeat(64)),
        from     : req.hash,
        unchanged: false,
      });
    },
    describe: (req) => {
      looked.push(req);
      return Promise.resolve({
        hash  : req.hash,
        label : 'the picture',
        answer: `LOOKED AT ${req.hash.slice(0, 8)}: ${req.question ?? '(the default question)'}`,
      });
    },
  };
  return { art, asked, redrawn, concepts, looked };
}
