import type { Git } from '@vn/git';
import type { Committer } from '../commit.js';
import { defineCommand } from '../command.js';
import { CommandRegistry } from '../registry.js';
import { CommandStack } from '../stack.js';
import { prop } from '../props.js';

it('requires both an explicit whitelist entry and declared files, independent of undo', async () => {
  const registry = new CommandRegistry();
  for (const id of ['test.allowed', 'test.other', 'test.undeclared'])
    registry.register(
      defineCommand({
        id,
        title      : id,
        description: id,
        mutating   : true,
        props      : { file: prop.string('file') },
        ...(id !== 'test.undeclared'
          ? { provenanceFiles: ({ file }: { file: string }) => [file] }
          : {}),
        async run() {
          return { message: 'done' };
        },
      }),
    );
  const provenance = jest.fn(async () => ({ head: 'head', dirty: true }));
  const prewarmProvenance = jest.fn(async (_files: readonly string[]) => {});
  const context = {
    root: '/ws',
    host: {},
    log : () => {},
    git : { provenance, prewarmProvenance } as unknown as Git,
  };
  const off = new CommandStack({ registry, context });
  await off.exec('test.allowed', { file: 'first.json' }, 'ui');
  expect(provenance).toHaveBeenLastCalledWith(undefined);
  await off.prewarmProvenance('test.allowed', { file: 'first.json' });
  expect(prewarmProvenance).not.toHaveBeenCalled();
  const on = new CommandStack({
    registry,
    context,
    trackedCommands   : ['test.allowed', 'test.undeclared'],
    trackerMode       : 'verify',
    trackerVerifyEvery: 3,
  });
  await on.exec('test.allowed', { file: 'second.json' }, 'ui');
  expect(provenance).toHaveBeenLastCalledWith({
    files      : ['second.json'],
    mode       : 'verify',
    verifyEvery: 3,
  });
  for (const id of ['test.other', 'test.undeclared']) {
    await on.exec(id, { file: 'ignored.json' }, 'ui');
    expect(provenance).toHaveBeenLastCalledWith(undefined);
  }
  const count = on.history().length;
  await on.prewarmProvenance('test.allowed', { file: 'prewarm.json' });
  expect(prewarmProvenance).toHaveBeenCalledWith(['prewarm.json']);
  await on.prewarmProvenance('test.other', { file: 'ignored.json' });
  await on.prewarmProvenance('test.undeclared', { file: 'ignored.json' });
  await on.prewarmProvenance('test.allowed', {});
  expect(prewarmProvenance).toHaveBeenCalledTimes(1);
  expect(on.history()).toHaveLength(count);
});

it.each(['immediate', 'batch', 'self'] as const)(
  'holds tracker invalidation across %s commits, including failure',
  async (kind) => {
    for (const fails of [false, true]) {
      let held = false;
      const end = jest.fn(() => {
        held = false;
      });
      const begin = jest.fn(() => {
        held = true;
        return end;
      });
      const commit = async () => {
        expect(held).toBe(true);
        if (fails) throw new Error('commit failure');
        return [];
      };
      const registry = new CommandRegistry();
      registry.register(
        defineCommand({
          id           : 'test.edit',
          title        : 'test.edit',
          description  : 'test.edit',
          props        : {},
          mutating     : true,
          defersCommit : kind === 'batch',
          commitsItself: kind === 'self',
          async run() {
            if (kind === 'self') await commit();
            return { message: 'edited' };
          },
        }),
      );
      const stack = new CommandStack({
        registry,
        context: {
          root: '/ws',
          host: {},
          log : () => {},
          git: {
            provenance             : async () => ({ head: 'head', dirty: true }),
            beginProvenanceMutation: begin,
          } as unknown as Git,
        },
        committer: { commit, commitBatch: commit } as unknown as Committer,
        timer    : { set: () => 1, clear: () => {} },
      });
      await stack.exec('test.edit', {}, 'ui');
      if (kind === 'batch') await stack.flushCommits();
      expect(begin).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(held).toBe(false);
    }
  },
);
