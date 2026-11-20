/**
 * What `pnpm gen:contracts` bundles and the index tests import: every `contracts.ts` by path, and
 * the registries a subject is checked against (the desktop's commands, both agents' tools, and the
 * stills family's slot kinds and the task kinds they fill).
 *
 * A new package's `src/contracts.ts`, or an app's `contracts.ts` anywhere under its `src/`, is
 * added to {@link DECLARED}; a test fails while one on disk is missing from it.
 */
import { createRegistry } from '@vn/authoring';
import { stillsFamily } from '@vn/stills';
import type { ContractIndex } from '@vn/contracts/query';
import {
  createContractTools,
  createRequestTools,
  createSourceTools,
} from '../../packages/agentreport/src/index.js';
import { createDesktopRegistry } from '../../apps/desktop/src/main/commands/index.js';
import { CONTRACTS as artgen } from '../../packages/artgen/src/contracts.js';
import { CONTRACTS as solver } from '../../packages/constraint-solver/src/contracts.js';
import { CONTRACTS as gengraph } from '../../packages/gengraph/src/contracts.js';
import { CONTRACTS as model } from '../../packages/model/src/contracts.js';
import { CONTRACTS as pipeline } from '../../packages/pipeline/src/contracts.js';
import { CONTRACTS as providers } from '../../packages/providers/src/contracts.js';
import { CONTRACTS as scriptedit } from '../../packages/scriptedit/src/contracts.js';
import { CONTRACTS as stills } from '../../packages/stills/src/contracts.js';
import { CONTRACTS as store } from '../../packages/store/src/contracts.js';
import { CONTRACTS as taskgraph } from '../../packages/taskgraph/src/contracts.js';
import { CONTRACTS as types } from '../../packages/types/src/contracts.js';
import { buildIndex, splitIndex, type Declared, type Facts, type IndexFiles } from './build.js';

/** Every `contracts.ts`, with the array it exports. */
export const DECLARED: readonly Declared[] = [
  { file: 'packages/artgen/src/contracts.ts', contracts: artgen },
  { file: 'packages/constraint-solver/src/contracts.ts', contracts: solver },
  { file: 'packages/gengraph/src/contracts.ts', contracts: gengraph },
  { file: 'packages/model/src/contracts.ts', contracts: model },
  { file: 'packages/pipeline/src/contracts.ts', contracts: pipeline },
  { file: 'packages/providers/src/contracts.ts', contracts: providers },
  { file: 'packages/scriptedit/src/contracts.ts', contracts: scriptedit },
  { file: 'packages/stills/src/contracts.ts', contracts: stills },
  { file: 'packages/store/src/contracts.ts', contracts: store },
  { file: 'packages/taskgraph/src/contracts.ts', contracts: taskgraph },
  { file: 'packages/types/src/contracts.ts', contracts: types },
];

/** The registries a subject is checked against, read from the code that defines them. */
export function facts(root: string): Facts {
  const commands = createDesktopRegistry().list();
  const debugTools = [
    ...createSourceTools({ sourceRoot: root, projectRoot: root }).keys(),
    ...createRequestTools({
      snapshot: { headers: () => [], body: () => undefined },
      redactor: { apply: (text) => text, leaks: () => [] },
    }).keys(),
    ...createContractTools().keys(),
  ];
  return {
    commands        : new Set(commands.map((c) => c.id)),
    tools           : new Set([...createRegistry().keys(), ...debugTools]),
    taskKinds       : new Set(stillsFamily.kinds.map((k) => k.task)),
    slots           : new Set(stillsFamily.kinds.map((k) => k.prefix)),
    commandContracts: commands
      .filter((c) => c.contracts?.length)
      .map((c) => ({ command: c.id, contracts: c.contracts ?? [] })),
    slotContracts: stillsFamily.kinds
      .filter((k) => k.contracts?.length)
      .map((k) => ({ prefix: k.prefix, contracts: k.contracts ?? [] })),
  };
}

/** The index the declarations produce, or an error naming every subject that names nothing. */
export function contractIndex(root: string): ContractIndex {
  return buildIndex(root, DECLARED, facts(root));
}

/** The summary file and the shards `pnpm gen:contracts` writes for {@link contractIndex}. */
export function contractFiles(root: string): IndexFiles {
  return splitIndex(contractIndex(root));
}
