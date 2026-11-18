/**
 * The analyst's `query_contracts` tool, over the committed contract index. Contracts are facts
 * about the code rather than the author's data, so the tool needs no grant: it is offered whenever
 * the analyst runs a tool loop, and what it hands back is charged to the analysis's one budget.
 */
import { z } from 'zod';
import { answer, QUERY_CONTRACTS_DESCRIPTION, type ContractIndex } from '@vn/contracts/query';
import type { Tool } from '@vn/authoring';
import { Budget } from './sourcetools.js';

export interface ContractToolOptions {
  /** Shared with the source and request tools, so one analysis has one budget. */
  budget?: Budget;
  /** Defaults to the committed index. */
  index?: ContractIndex;
}

const ARGS = z.object({
  subject: z
    .string()
    .optional()
    .describe('module:<path>, function:<path>#<export>, command:<id>, tool:<name>, …'),
  id     : z.string().optional().describe('a contract id such as script.lineIdsAllocated'),
  text   : z.string().optional().describe('words every matching contract contains'),
  full   : z.boolean().optional().describe('also return what each rule prevents, detail and links'),
});

type Args = z.infer<typeof ARGS>;

/** The tool, keyed by name, ready to splice into the analyst's registry. */
export function createContractTools(opts: ContractToolOptions = {}): Map<string, Tool> {
  const budget = opts.budget ?? new Budget();
  const tool: Tool<Args> = {
    name       : 'query_contracts',
    description: QUERY_CONTRACTS_DESCRIPTION,
    mutating   : false,
    args       : ARGS,
    async run(args) {
      const answered = answer(args, opts.index ? { index: opts.index } : {});
      if (!answered.ok) return answered;
      const over = budget.take(Buffer.byteLength(answered.output, 'utf8'));
      return over ? { ok: false, output: over } : answered;
    },
  };
  return new Map([[tool.name, tool as Tool]]);
}
