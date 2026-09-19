/**
 * `doc.write`'s message is the commit subject under commit-on-save, so what it says for an
 * autosave is a contract rather than wording.
 */
import type { CommandContext } from '@vn/commands';
import { docWrite } from '../doc.js';
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
