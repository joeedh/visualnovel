/**
 * `gate.approve`'s refusals, which are the only thing an author sees when the tasks or graph
 * editor's `RESOLVE →` opens the form: both open it on a character and leave which portrait to
 * the author, so the form's first verdict is always a refusal about the empty `hash`.
 */
import { gateApprove } from '../gate.js';
import type { CommandContext } from '@vn/commands';
import type { CommandHost } from '../host.js';

type Candidacy = Awaited<ReturnType<CommandHost['session']['gateCandidacy']>>;

const ctxWith = (state: Partial<Candidacy>): CommandContext<CommandHost> =>
  ({
    host: {
      session: {
        gateCandidacy: async (): Promise<Candidacy> => ({
          character: true,
          candidate: false,
          approved: false,
          candidates: 0,
          ...state,
        }),
      },
    },
  }) as unknown as CommandContext<CommandHost>;

const reasonFor = async (
  props: { characterId: string; hash: string },
  state: Partial<Candidacy>,
): Promise<string> => {
  const verdict = await gateApprove.check!(props, ctxWith(state));
  expect(verdict.ok).toBe(false);
  return verdict.ok ? '' : verdict.reason;
};

describe('gate.approve check', () => {
  it('names the unanswered field when no hash was given, rather than the empty lookup', async () => {
    const reason = await reasonFor({ characterId: 'aiko', hash: '' }, { candidates: 1 });
    expect(reason).toContain('Name the portrait to approve');
    expect(reason).toContain('1 on file for aiko');
    // The old sentence read "aiko has no candidate  (1 on file)" — a lookup failure for a hash
    // the author was never asked for yet.
    expect(reason).not.toContain('no candidate');
  });

  it('says the pipeline has not drawn one yet when there is nothing to name', async () => {
    const reason = await reasonFor({ characterId: 'aiko', hash: '' }, { candidates: 0 });
    expect(reason).toContain('no portrait yet');
    expect(reason).toContain('run the pipeline');
  });

  it('still reports a hash that is not a candidate as the lookup it is', async () => {
    const reason = await reasonFor({ characterId: 'aiko', hash: 'beef' }, { candidates: 2 });
    expect(reason).toContain('no candidate beef');
    expect(reason).toContain('2 on file');
  });

  it('refuses an unknown character before it looks at the hash', async () => {
    const reason = await reasonFor({ characterId: 'nobody', hash: '' }, { character: false });
    expect(reason).toBe('No character "nobody".');
  });
});
