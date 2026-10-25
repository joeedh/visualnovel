/**
 * `project.setKey`'s check refuses while the session is busy, because the save would otherwise sit
 * in the mutation queue behind the run and look as though pressing Save key did nothing.
 */
import { projectSetKey } from '../project.js';
import type { CommandContext } from '@vn/commands';
import type { CommandHost } from '../host.js';

const ctxWith = (busy: string | undefined): CommandContext<CommandHost> =>
  ({
    host: {
      session: {
        busy      : () => busy,
        previewKey: async () => ({ ok: true, message: 'Write the gemini key.' }),
      },
    },
  }) as unknown as CommandContext<CommandHost>;

const props = { provider: 'gemini', key: '', scope: 'user' } as const;

describe('project.setKey check', () => {
  it('names the run it is waiting behind when the session is busy', async () => {
    const verdict = await projectSetKey.check!(props, ctxWith('a pipeline run'));
    expect(verdict).toEqual({
      ok    : false,
      reason: 'a pipeline run is still running; wait for it to finish.',
    });
  });

  it('describes the write when the session is idle', async () => {
    const verdict = await projectSetKey.check!(props, ctxWith(undefined));
    expect(verdict).toEqual({ ok: true, note: 'Write the gemini key.' });
  });
});
