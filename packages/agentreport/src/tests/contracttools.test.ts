import type { ContractIndex } from '@vn/contracts/query';
import type { ToolContext } from '@vn/authoring';
import { createContractTools } from '../contracttools.js';
import { Budget } from '../sourcetools.js';

const index: ContractIndex = {
  contracts: [
    {
      id      : 'script.lineIds',
      rule    : 'Line ids are allocated and stored.',
      prevents: 'Re-pointing shots at other lines.',
      subjects: ['module:packages/scriptedit/src/lineops.ts'],
      declared: 'packages/scriptedit/src/lineops.ts',
    },
  ],
  bySubject: { 'module:packages/scriptedit/src/lineops.ts': ['script.lineIds'] },
};

const ctx = {} as ToolContext;

describe('query_contracts in the analyst', () => {
  it('finds a contract by the module it is attached to', async () => {
    const tool = createContractTools({ index }).get('query_contracts')!;
    expect(tool.mutating).toBe(false);
    const res = await tool.run({ subject: 'module:packages/scriptedit/' }, ctx);
    expect(res).toEqual({
      ok    : true,
      output:
        'script.lineIds: Line ids are allocated and stored. ' +
        '[module:packages/scriptedit/src/lineops.ts]',
    });
  });

  it('charges what it returns to the analysis budget, and refuses once that is spent', async () => {
    const budget = new Budget(120);
    const tool = createContractTools({ index, budget }).get('query_contracts')!;
    expect((await tool.run({ id: 'script.lineIds' }, ctx)).ok).toBe(true);
    expect(budget.spent).toBeGreaterThan(0);
    const spent = await tool.run({ id: 'script.lineIds', full: true }, ctx);
    expect(spent.ok).toBe(false);
    expect(spent.output).toContain('reading budget');
  });

  it('refuses a query that names nothing to look up, without charging for it', async () => {
    const budget = new Budget(100);
    const res = await createContractTools({ index, budget }).get('query_contracts')!.run({}, ctx);
    expect(res.ok).toBe(false);
    expect(budget.spent).toBe(0);
  });
});

describe('query_contracts over the committed index', () => {
  it('finds the line-id contract by the module it is declared in', async () => {
    const res = await createContractTools()
      .get('query_contracts')!
      .run({ subject: 'module:packages/scriptedit/src/lineops.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/^script\.lineIdsAllocated: Line ids are allocated and stored/m);
  });
});
