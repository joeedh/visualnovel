/**
 * `query_contracts`: the pipeline contracts, read from the committed index, so that when a tool
 * refuses, the agent can look up the rule behind the refusal by `tool:<name>`. Read-only, and
 * deferred like every tool outside the always-loaded six.
 */
import { z } from 'zod';
import { answer, QUERY_CONTRACTS_DESCRIPTION } from '@vn/contracts/query';
import { fail, ok, type Tool } from './core.js';

const queryContractsTool: Tool<{ subject?: string; id?: string; text?: string; full?: boolean }> = {
  name       : 'query_contracts',
  description: QUERY_CONTRACTS_DESCRIPTION,
  mutating   : false,
  args: z.object({
    subject: z
      .string()
      .optional()
      .describe('tool:<name>, command:<id>, module:<repo path>, function:<path>#<export>, …'),
    id     : z.string().optional().describe('a contract id such as script.lineIdsAllocated'),
    text   : z.string().optional().describe('words every matching contract contains'),
    full   : z.boolean().optional().describe('also return what each rule prevents, and its links'),
  }),
  async run(a) {
    const answered = answer(a);
    return answered.ok ? ok(answered.output) : fail(answered.output);
  },
};

export { queryContractsTool };
