/**
 * What `pnpm gen:contracts` bundles and the index tests import: every `contracts.ts` by path, and
 * the registries a subject is checked against (the desktop's commands, both agents' tools, the
 * task kinds and the slot address prefixes).
 *
 * A new package's `src/contracts.ts`, or an app's `contracts.ts` anywhere under its `src/`, is
 * added to {@link DECLARED}; a test fails while one on disk is missing from it.
 */
import type { TaskKind } from '@vn/types';
import { createRegistry } from '@vn/authoring';
import { parseSlot } from '@vn/stills/slotaddr';
import type { ContractIndex } from '@vn/contracts/query';
import {
  createContractTools,
  createRequestTools,
  createSourceTools,
} from '../../packages/agentreport/src/index.js';
import { createDesktopRegistry } from '../../apps/desktop/src/main/commands/index.js';
import { CONTRACTS as scriptedit } from '../../packages/scriptedit/src/contracts.js';
import { CONTRACTS as store } from '../../packages/store/src/contracts.js';
import { CONTRACTS as taskgraph } from '../../packages/taskgraph/src/contracts.js';
import { buildIndex, type Declared, type Facts } from './build.js';

/** Every `contracts.ts`, with the array it exports. */
export const DECLARED: readonly Declared[] = [
  { file: 'packages/scriptedit/src/contracts.ts', contracts: scriptedit },
  { file: 'packages/store/src/contracts.ts', contracts: store },
  { file: 'packages/taskgraph/src/contracts.ts', contracts: taskgraph },
];

/** Every task kind, spelled out so the type checker fails here when `TaskKind` changes. */
const TASK_KINDS: Record<TaskKind, true> = {
  location_ref : true,
  portrait     : true,
  model_sheet  : true,
  outfit_sheet : true,
  shot_image   : true,
  vision_review: true,
  prompt_refine: true,
};

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
    taskKinds       : new Set(Object.keys(TASK_KINDS)),
    slot: (prefix) =>
      ['a', 'a/b', 'a/b/c'].some((rest) => parseSlot(`${prefix}:${rest}`)?.kind === prefix),
    commandContracts: commands
      .filter((c) => c.contracts?.length)
      .map((c) => ({ command: c.id, contracts: c.contracts ?? [] })),
  };
}

/** The index the declarations produce, or an error naming every subject that names nothing. */
export function contractIndex(root: string): ContractIndex {
  return buildIndex(root, DECLARED, facts(root));
}
