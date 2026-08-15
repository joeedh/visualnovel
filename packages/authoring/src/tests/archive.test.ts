import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import {
  ARCHIVE_DIR,
  archiveUpload,
  createRegistry,
  listArchive,
  uploadSuggestions,
  Workspace,
  type Tool,
  type ToolContext,
  type UploadBatch,
} from '../index.js';

const AT = new Date(2026, 7, 15, 14, 22, 33);

/** A project and a directory of the author's own documents, outside it. */
async function tempProject(): Promise<{
  ctx: ToolContext;
  dir: string;
  inbox: string;
  cleanup: () => Promise<void>;
}> {
  const base = await fs.mkdtemp(join(tmpdir(), 'vn-archive-'));
  const dir = join(base, 'project');
  const inbox = join(base, 'inbox');
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  await fs.mkdir(inbox, { recursive: true });
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\n');
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  return { ctx, dir, inbox, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

const registry = createRegistry();
function tool(name: string): Tool {
  const t = registry.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
const run = (name: string, args: unknown, ctx: ToolContext) =>
  tool(name).run(tool(name).args.parse(args), ctx);

async function drop(inbox: string, name: string, text: string | Buffer): Promise<string> {
  const path = join(inbox, name);
  await fs.writeFile(path, text);
  return path;
}

describe('archiving an upload', () => {
  it('keeps the originals under a stamped batch directory, by their own names', async () => {
    const { ctx, dir, inbox, cleanup } = await tempProject();
    try {
      const files = [
        await drop(inbox, 'notes.md', '# Worldbuilding\n\nThe third district burned.\n'),
        await drop(inbox, 'cast.txt', 'Aiko, a transfer student.\n'),
      ];
      const batch = await archiveUpload(ctx.workspace, files, AT);

      expect(batch.dir).toBe(`${ARCHIVE_DIR}/20260815-142233-notes`);
      expect(batch.skipped).toEqual([]);
      expect(batch.files.map((f) => f.stored)).toEqual([
        `${ARCHIVE_DIR}/20260815-142233-notes/notes.md`,
        `${ARCHIVE_DIR}/20260815-142233-notes/cast.txt`,
      ]);
      expect(batch.files.every((f) => f.readable)).toBe(true);
      expect(batch.files[0]!.bytes).toBe(44);
      // Verbatim: the bytes on disk are the bytes the author handed over.
      expect(await fs.readFile(join(dir, batch.files[0]!.stored), 'utf8')).toBe(
        '# Worldbuilding\n\nThe third district burned.\n',
      );
    } finally {
      await cleanup();
    }
  });

  it('gives a second upload in the same second its own directory', async () => {
    const { ctx, inbox, cleanup } = await tempProject();
    try {
      const one = [await drop(inbox, 'notes.md', 'first')];
      const first = await archiveUpload(ctx.workspace, one, AT);
      const second = await archiveUpload(ctx.workspace, one, AT);
      expect(first.dir).toBe(`${ARCHIVE_DIR}/20260815-142233-notes`);
      expect(second.dir).toBe(`${ARCHIVE_DIR}/20260815-142233-notes-2`);
    } finally {
      await cleanup();
    }
  });

  it('archives a Word document unchanged and says why it cannot be read', async () => {
    const { ctx, dir, inbox, cleanup } = await tempProject();
    try {
      // A .docx is a zip, so the bytes are binary as well as the extension being unknown.
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
      const batch = await archiveUpload(
        ctx.workspace,
        [await drop(inbox, 'draft.docx', bytes)],
        AT,
      );

      expect(batch.skipped).toEqual([]);
      expect(batch.files[0]!.readable).toBe(false);
      expect(batch.files[0]!.note).toBe(
        'archived, not yet readable: no converter for Word document',
      );
      expect(await fs.readFile(join(dir, batch.files[0]!.stored))).toEqual(bytes);
    } finally {
      await cleanup();
    }
  });

  it('refuses a directory, a missing path, a file already in the project, and a repeated name', async () => {
    const { ctx, dir, inbox, cleanup } = await tempProject();
    try {
      const sub = join(inbox, 'nested');
      await fs.mkdir(sub, { recursive: true });
      const repeated = await drop(sub, 'notes.md', 'a second notes.md');
      const batch = await archiveUpload(
        ctx.workspace,
        [
          await drop(inbox, 'notes.md', 'keep me'),
          sub,
          join(inbox, 'ghost.md'),
          join(dir, 'project.yaml'),
          repeated,
        ],
        AT,
      );

      expect(batch.files.map((f) => f.stored)).toEqual([
        `${ARCHIVE_DIR}/20260815-142233-notes/notes.md`,
      ]);
      expect(batch.skipped.map((s) => s.reason)).toEqual([
        'nested is not a regular file',
        `no such file: ${join(inbox, 'ghost.md')}`,
        'project.yaml is already inside the project',
        'notes.md is in this upload twice',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('creates no directory when nothing survives', async () => {
    const { ctx, dir, inbox, cleanup } = await tempProject();
    try {
      const batch = await archiveUpload(ctx.workspace, [join(inbox, 'ghost.md')], AT);
      expect(batch).toEqual({
        dir: '',
        files: [],
        skipped: [
          { source: join(inbox, 'ghost.md'), reason: `no such file: ${join(inbox, 'ghost.md')}` },
        ],
      });
      await expect(fs.stat(join(dir, ARCHIVE_DIR))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe('what the agent can see of the archive', () => {
  it('finds nothing by search, and reads it when named', async () => {
    const { ctx, inbox, cleanup } = await tempProject();
    try {
      const batch = await archiveUpload(
        ctx.workspace,
        [await drop(inbox, 'notes.md', 'The lighthouse keeper never blinked.\n')],
        AT,
      );

      // The requirement, as a test: sweeps walk allow-lists that archive/ is not on…
      const found = await run('search', { query: 'lighthouse keeper' }, ctx);
      expect(found.data).toEqual([]);
      const bible = await run('search_bible', { query: 'lighthouse keeper' }, ctx);
      expect(bible.data).toEqual([]);

      // …and read_file still serves it by name.
      const read = await run('read_file', { path: batch.files[0]!.stored }, ctx);
      expect(read.ok).toBe(true);
      expect(read.output).toContain('lighthouse keeper');
    } finally {
      await cleanup();
    }
  });

  it('lists the batches newest first, without opening one', async () => {
    const { ctx, inbox, cleanup } = await tempProject();
    try {
      await archiveUpload(ctx.workspace, [await drop(inbox, 'old.md', 'older')], AT);
      await archiveUpload(
        ctx.workspace,
        [await drop(inbox, 'new.md', 'newer')],
        new Date(2026, 7, 16, 9, 0, 0),
      );

      const batches = await listArchive(ctx.workspace);
      expect(batches.map((b) => b.dir)).toEqual([
        `${ARCHIVE_DIR}/20260816-090000-new`,
        `${ARCHIVE_DIR}/20260815-142233-old`,
      ]);

      const listed = await run('list_archive', {}, ctx);
      expect(listed.output).toContain(`${ARCHIVE_DIR}/20260816-090000-new/new.md (5 bytes)`);
      expect(listed.output).not.toContain('newer');
    } finally {
      await cleanup();
    }
  });

  it('says the archive is empty when there is none', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      expect(await listArchive(ctx.workspace)).toEqual([]);
      expect((await run('list_archive', {}, ctx)).output).toBe('The archive is empty.');
    } finally {
      await cleanup();
    }
  });
});

describe('the suggestions', () => {
  const batch = (names: string[], readable = true): UploadBatch => ({
    dir: 'archive/x',
    files: names.map((n) => ({ source: n, stored: `archive/x/${n}`, bytes: 1, readable })),
    skipped: [],
  });

  it('offers three or four next prompts, chosen by name and count alone', () => {
    expect(uploadSuggestions(batch(['notes.md']))).toEqual([
      'Summarize these and file them under `wiki/`.',
      'Turn the people described here into character sheets.',
      "Read them and tell me what's inconsistent with the story bible.",
    ]);
    const many = uploadSuggestions(batch(['act-one.fountain', 'cast.txt', 'timeline.md']));
    expect(many).toHaveLength(4);
    expect(many).toContain('Extract any scenes into `scenes/`, one file each.');
    expect(many).toContain('Turn the people described here into character sheets.');
  });

  it('does not offer to read what cannot be read', () => {
    const said = uploadSuggestions(batch(['draft.docx'], false));
    expect(said.every((s) => !s.includes('Summarize'))).toBe(true);
    expect(said[0]).toContain('cannot read them yet');
  });
});
