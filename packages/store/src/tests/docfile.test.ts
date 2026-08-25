/**
 * The refusals a whole-document surface must return to its caller. Both the agent's
 * `read_file`/`write_file` and the desktop's `doc.*` commands run this code, so a rule proved
 * here is proved for both.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, writeFileAtomic } from '@vn/util';
import {
  MAX_DOC_BYTES,
  SECRETS_REFUSAL,
  checkDocWrite,
  readDocFile,
  writeDocFile,
  type GuardedWriters,
} from '../docfile.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vn-docfile-'));
}

const WRITERS: GuardedWriters = { scenes: 'story.*', graphs: 'gengraph.*' };

const reason = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : (r.reason ?? ''));

describe('reading a document', () => {
  it('returns the text, the byte count and the hash of the bytes', async () => {
    const root = await tempRoot();
    await writeFileAtomic(join(root, 'wiki', 'history.md'), '# History\n');

    const read = await readDocFile(root, 'wiki/history.md');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file).toEqual({
      path: 'wiki/history.md',
      text: '# History\n',
      hash: sha256('# History\n'),
      bytes: 10,
    });
  });

  it('refuses a path outside the workspace', async () => {
    const root = await tempRoot();
    expect(reason(await readDocFile(root, '../elsewhere.md'))).toMatch(/outside the workspace/);
  });

  it('refuses keys/ whether or not the file is there, and refuses the directory itself', async () => {
    const root = await tempRoot();
    await writeFileAtomic(join(root, 'keys', 'anthropic.txt'), 'sk-ant-real-key\n');

    expect(reason(await readDocFile(root, 'keys/anthropic.txt'))).toBe(SECRETS_REFUSAL);
    expect(reason(await readDocFile(root, 'keys/absent.txt'))).toBe(SECRETS_REFUSAL);
    expect(reason(await readDocFile(root, 'keys'))).toBe(SECRETS_REFUSAL);
    // Windows resolves this to the same directory, so the refusal cannot be case-sensitive.
    expect(reason(await readDocFile(root, 'Keys/anthropic.txt'))).toBe(SECRETS_REFUSAL);
  });

  it('allows a keys directory that is not the project’s own', async () => {
    const root = await tempRoot();
    await writeFileAtomic(join(root, 'wiki', 'keys', 'notes.md'), '# Keys of the city\n');

    const read = await readDocFile(root, 'wiki/keys/notes.md');
    expect(read.ok).toBe(true);
  });

  it('refuses a missing file and a directory by name', async () => {
    const root = await tempRoot();
    await writeFileAtomic(join(root, 'wiki', 'history.md'), 'x');
    expect(reason(await readDocFile(root, 'wiki/absent.md'))).toBe('no such file: wiki/absent.md');
    expect(reason(await readDocFile(root, 'wiki'))).toMatch(/is a directory/);
  });

  it('refuses a file past the bound rather than shipping it', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'big.md'), 'a'.repeat(MAX_DOC_BYTES + 1));
    expect(reason(await readDocFile(root, 'big.md'))).toMatch(/past the 1 MB/);
  });

  it('refuses a binary file rather than showing it as mojibake', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'portrait.png'), Buffer.from([0x89, 0x50, 0x00, 0xff, 0xfe]));
    expect(reason(await readDocFile(root, 'portrait.png'))).toBe('portrait.png is not a text file');
  });
});

describe('saving a document', () => {
  /** A file on disk plus the hash a reader would have handed the editor. */
  async function seeded(text: string): Promise<{ root: string; hash: string }> {
    const root = await tempRoot();
    await writeFileAtomic(join(root, 'wiki', 'note.md'), text);
    const read = await readDocFile(root, 'wiki/note.md');
    return { root, hash: read.ok ? read.file.hash : '' };
  }

  it('writes when the hash still matches, and reports the new one', async () => {
    const { root, hash } = await seeded('one\n');
    const write = await writeDocFile(root, 'wiki/note.md', 'two\n', hash, WRITERS);
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.hash).toBe(sha256('two\n'));
    const after = await readDocFile(root, 'wiki/note.md');
    expect(after.ok && after.file.text).toBe('two\n');
  });

  it('refuses when the file changed underneath, by content and not by clock', async () => {
    const { root, hash } = await seeded('one\n');
    await writeFileAtomic(join(root, 'wiki', 'note.md'), 'somebody else\n');
    expect(reason(await checkDocWrite(root, 'wiki/note.md', 'two\n', hash, WRITERS))).toMatch(
      /changed underneath this edit/,
    );
  });

  it('accepts a file rewritten with the bytes it already had', async () => {
    const { root, hash } = await seeded('one\n');
    // An undo runs `git read-tree -u --reset`, which rewrites every file, so the mtime moved and
    // the content did not. Identical content is not a conflict.
    await writeFileAtomic(join(root, 'wiki', 'note.md'), 'one\n');
    const check = await checkDocWrite(root, 'wiki/note.md', 'two\n', hash, WRITERS);
    expect(check.ok).toBe(true);
  });

  it('refuses keys/ before it considers what is being written', async () => {
    const root = await tempRoot();
    expect(reason(await checkDocWrite(root, 'keys/anthropic.txt', 'x', '', WRITERS))).toBe(
      SECRETS_REFUSAL,
    );
  });

  it('refuses scenes/ by naming the writer that owns it', async () => {
    const root = await tempRoot();
    const check = await checkDocWrite(root, 'scenes/s1.md', 'x', '', WRITERS);
    expect(reason(check)).toBe('scenes/s1.md is written by story.*, not whole');
  });

  it('refuses a generation graph, which deserializes rather than reading as text', async () => {
    const root = await tempRoot();
    const check = await checkDocWrite(root, 'vngen/work/graphs/aiko.json', '{}', '', WRITERS);
    expect(reason(check)).toBe('vngen/work/graphs/aiko.json is written by gengraph.*, not whole');
    const lib = await checkDocWrite(root, 'vngen/work/graphs/lib/pose.json', '{}', '', WRITERS);
    expect(reason(lib)).toMatch(/written by gengraph\.\*/);
    // A sibling whose name merely starts the same way is an ordinary document.
    const beside = await checkDocWrite(root, 'vngen/work/graphsnotes.md', 'x', '', WRITERS);
    expect(beside.ok).toBe(true);
  });

  it('refuses a path outside the workspace and one past the bound', async () => {
    const root = await tempRoot();
    expect(reason(await checkDocWrite(root, '../x.md', 'x', '', WRITERS))).toMatch(/outside/);
    const big = 'a'.repeat(MAX_DOC_BYTES + 1);
    expect(reason(await checkDocWrite(root, 'big.md', big, '', WRITERS))).toMatch(/past the 1 MB/);
  });

  it('refuses front-matter that will not parse at all', async () => {
    const { root, hash } = await seeded('---\nid: note\n---\n\nbody\n');
    const broken = '---\nid: [unclosed\n---\n\nbody\n';
    expect(reason(await checkDocWrite(root, 'wiki/note.md', broken, hash, WRITERS))).toMatch(
      /front-matter will not parse/,
    );
  });

  it('saves front-matter that parses but is not a valid entity — that is a diagnostic', async () => {
    const { root, hash } = await seeded('---\nid: ada\ntype: character\nname: Ada\n---\n\nx\n');
    const halfTyped = '---\nid: ada\ntype: character\nname:\n---\n\nx\n';
    expect((await checkDocWrite(root, 'wiki/note.md', halfTyped, hash, WRITERS)).ok).toBe(true);
  });

  it('refuses a save that drops a type: tag the file had — that is a deletion', async () => {
    const { root, hash } = await seeded('---\nid: ada\ntype: character\n---\n\nx\n');
    const untagged = '---\nid: ada\n---\n\nx\n';
    expect(reason(await checkDocWrite(root, 'wiki/note.md', untagged, hash, WRITERS))).toMatch(
      /drops it — that deletes the character/,
    );
  });

  it('refuses a create over an existing file, and a save over one that is gone', async () => {
    const { root, hash } = await seeded('one\n');
    expect(reason(await checkDocWrite(root, 'wiki/note.md', 'x', '', WRITERS))).toBe(
      'wiki/note.md already exists',
    );
    expect(reason(await checkDocWrite(root, 'wiki/gone.md', 'x', hash, WRITERS))).toMatch(
      /is gone/,
    );
  });
});
