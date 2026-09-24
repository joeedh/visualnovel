/**
 * `doc.write`'s message is the commit subject under commit-on-save, so what it says for an
 * autosave is a contract rather than wording. `doc.create`'s `dir` runs over a real directory,
 * since where the page lands is the whole of what it changes.
 */
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '@vn/commands';
import { WorkspaceSession, type SessionDeps } from '../../session.js';
import { docCreate, docWrite } from '../doc.js';
import type { CommandHost } from '../host.js';

/** A host whose session saves anything and reports it, the one member `doc.write` reaches. */
function ctx(diagnostic?: string): CommandContext<CommandHost> {
  return {
    host: {
      session: {
        saveDoc: async (path: string, text: string) => ({
          ok: true,
          path,
          hash : 'h',
          bytes: text.length,
          ...(diagnostic ? { diagnostic } : {}),
        }),
      },
    },
  } as unknown as CommandContext<CommandHost>;
}

describe('doc.write', () => {
  it('says Saved for the author pressing Save', async () => {
    const out = await docWrite.run(
      { path: 'wiki/a.md', text: 'abc', seenHash: 'h0', auto: false },
      ctx(),
    );
    expect(out.message).toBe('Saved wiki/a.md (3 bytes).');
    expect(out.written).toEqual(['wiki/a.md']);
  });

  it('says Autosaved for an autosave tick, with any diagnostic still beside it', async () => {
    const out = await docWrite.run(
      { path: 'wiki/a.md', text: 'abc', seenHash: 'h0', auto: true },
      ctx('name is required'),
    );
    expect(out.message).toBe('Autosaved wiki/a.md (3 bytes). name is required');
  });

  it('defaults to a manual save, so every existing caller keeps its subject', () => {
    expect(docWrite.props.auto?.default).toBe(false);
  });
});

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

describe('doc.create with dir', () => {
  let dir: string;
  let ctx: CommandContext<CommandHost>;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-create-')));
    await mkdir(join(dir, 'wiki', 'lore'), { recursive: true });
    ctx = {
      host: { session: new WorkspaceSession(dir, true, deps), ui: () => {} },
    } as unknown as CommandContext<CommandHost>;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('files a note in the folder it names', async () => {
    const props = { kind: 'note' as const, name: 'The Canal', open: false, dir: 'wiki/lore' };
    expect(await docCreate.check!(props, ctx)).toEqual({
      ok  : true,
      note: 'Creates wiki/lore/the_canal.md.',
    });
    const out = await docCreate.run(props, ctx);
    expect(out.written).toEqual(['wiki/lore/the_canal.md']);
    expect(await readdir(join(dir, 'wiki', 'lore'))).toEqual(['the_canal.md']);
  });

  it('files a note at the wiki root when dir is empty, as before', async () => {
    const out = await docCreate.run({ kind: 'note', name: 'Canal', open: false, dir: '' }, ctx);
    expect(out.written).toEqual(['wiki/canal.md']);
  });

  it('refuses dir for every other kind, and a folder outside the wiki', async () => {
    const check = (kind: 'character' | 'location' | 'note' | 'skill', folder: string) =>
      docCreate.check!({ kind, name: 'Aiko', open: false, dir: folder }, ctx);
    expect(await check('character', 'wiki/lore')).toEqual({
      ok    : false,
      reason:
        'A character sheet is always created in characters/; move it afterwards to file it elsewhere.',
    });
    expect(await check('location', 'wiki/lore')).toMatchObject({ ok: false });
    expect(await check('skill', 'wiki/lore')).toMatchObject({ ok: false });
    expect(await check('note', 'archive')).toEqual({
      ok    : false,
      reason: 'A wiki page is filed under wiki/, and archive is not.',
    });
    expect(await check('note', 'wiki/nope')).toEqual({
      ok    : false,
      reason: 'no such folder: wiki/nope',
    });
  });
});
