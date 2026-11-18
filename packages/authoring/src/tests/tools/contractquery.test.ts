import { INDEX } from '@vn/contracts/query';
import type { ToolContext } from '../../tools/index.js';
import { run, tool } from './testkit.js';

// The tool reads only the committed index, so it runs in a bare context
const ctx = {} as ToolContext;

describe('query_contracts', () => {
  it('is registered read-only', () => {
    expect(tool('query_contracts').mutating).toBe(false);
  });

  it('answers a lookup from the committed index, and refuses a query that names nothing', async () => {
    expect(INDEX.contracts.length).toBeGreaterThan(0);
    const found = await run('query_contracts', { subject: 'tool:edit_scene' }, ctx);
    expect(found.ok).toBe(true);
    expect(found.output).toContain('script.lineIdsAllocated');
    const empty = await run('query_contracts', {}, ctx);
    expect(empty.ok).toBe(false);
  });
});
