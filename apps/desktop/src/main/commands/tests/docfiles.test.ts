/**
 * What `doc.move` and `doc.copy` report: the message, which is the commit subject under
 * commit-on-save, the `written` list the panes and the affects check read, and the pushes a window
 * acts on. Each runs over a real directory, since what they report is what happened on disk.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '@vn/commands';
import type { UiEffect } from '../../../shared/ipc.js';
import { WorkspaceSession, type SessionDeps } from '../../session.js';
import { docCopy, docMove } from '../docfiles.js';
import type { CommandHost } from '../host.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

describe('doc.move and doc.copy', () => {
  let dir: string;
  let ctx: CommandContext<CommandHost>;
  /** Every push, and `returned` once a run has resolved, in the order they happened. */
  let events: (UiEffect | 'returned')[];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-docfiles-')));
    await mkdir(join(dir, 'wiki', 'lore'), { recursive: true });
    await writeFile(join(dir, 'wiki', 'a.md'), '# A\n');
    await writeFile(join(dir, 'wiki', 'b.md'), '# B\n');
    await writeFile(join(dir, 'wiki', 'index.md'), '[A](a.md)\n');
    events = [];
    ctx = {
      host: {
        session: new WorkspaceSession(dir, true, deps),
        ui     : (effect: UiEffect) => void events.push(effect),
        uiAll  : (effect: UiEffect) => void events.push(effect),
      },
    } as unknown as CommandContext<CommandHost>;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a move, the links it rewrote, and every path it wrote', async () => {
    const out = await docMove.run({ paths: ['wiki/a.md'], into: 'wiki/lore', name: '' }, ctx);
    expect(out.message).toBe('Moved wiki/a.md to wiki/lore/a.md; updated links in 1 document.');
    expect(out.written).toEqual(['wiki/a.md', 'wiki/lore/a.md', 'wiki/index.md']);
  });

  it('says Renamed for a new name in the same folder, and lists several items', async () => {
    const renamed = await docMove.run({ paths: ['wiki/b.md'], into: 'wiki', name: 'c.md' }, ctx);
    expect(renamed.message).toBe('Renamed wiki/b.md to wiki/c.md.');
    const moved = await docMove.run(
      { paths: ['wiki/a.md', 'wiki/c.md'], into: 'wiki/lore', name: '' },
      ctx,
    );
    expect(moved.message).toBe(
      'Moved wiki/a.md and wiki/c.md into wiki/lore; updated links in 1 document.',
    );
  });

  it('tells every window what moved before the run returns', async () => {
    await docMove.run({ paths: ['wiki/a.md'], into: 'wiki/lore', name: '' }, ctx);
    events.push('returned');
    expect(events).toEqual([
      { type: 'docs', action: 'moved', moves: [{ from: 'wiki/a.md', to: 'wiki/lore/a.md' }] },
      { type: 'docs', action: 'reveal', paths: ['wiki/lore/a.md'] },
      'returned',
    ]);
  });

  it('reports a copy and writes only the copies, with no moved push', async () => {
    const out = await docCopy.run({ paths: ['wiki/a.md'], into: 'wiki' }, ctx);
    expect(out.message).toBe('Copied wiki/a.md to wiki/a-copy.md.');
    expect(out.written).toEqual(['wiki/a-copy.md']);
    expect(events).toEqual([{ type: 'docs', action: 'reveal', paths: ['wiki/a-copy.md'] }]);
  });

  it('says what it would do before it runs', async () => {
    expect(
      await docMove.check!({ paths: ['wiki/a.md', 'wiki/b.md'], into: 'wiki/lore', name: '' }, ctx),
    ).toEqual({ ok: true, note: 'Moves wiki/a.md and wiki/b.md into wiki/lore.' });
    expect(
      await docMove.check!({ paths: ['wiki/a.md'], into: 'wiki', name: 'a.txt' }, ctx),
    ).toEqual({
      ok  : true,
      note: 'Renames wiki/a.md to wiki/a.txt. a.txt is not markdown, so the Wiki branch will stop listing it.',
    });
  });
});
