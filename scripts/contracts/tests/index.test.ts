/**
 * The contract index's three guards: the committed `contracts.json` equals a regeneration, every
 * declared contract is listed in its package's `contracts.ts` (and every `contracts.ts` in
 * `entry.ts`), and every contract has a test that pins it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Contract } from '@vn/contracts';
import type { ContractIndex } from '@vn/contracts/query';
import {
  buildIndex,
  constNameOf,
  declaredConsts,
  idOfConst,
  srcRootOf,
  type Facts,
} from '../build.js';
import { contractIndex, DECLARED } from '../entry.js';

const REPO = resolve(__dirname, '../../..');

const committed = JSON.parse(
  readFileSync(join(REPO, 'packages/contracts/contracts.json'), 'utf8'),
) as ContractIndex;

/** Every package's and app's source root. */
function srcRoots(): string[] {
  const roots: string[] = [];
  for (const top of ['packages', 'apps']) {
    for (const entry of readdirSync(join(REPO, top), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(`${top}/${entry.name}/src`);
    }
  }
  return roots;
}

/** Every file under `dir` whose name satisfies `keep`, repo-relative. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(REPO, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(at);
      } else if (keep(entry.name)) {
        out.push(at);
      }
    }
  };
  walk(dir);
  return out;
}

describe('contracts.json', () => {
  it('equals a regeneration (run `pnpm gen:contracts` after declaring or editing a contract)', () => {
    const fresh = contractIndex(REPO);
    // Contract by contract first, so a stale file names the first one that moved
    for (const c of fresh.contracts) {
      expect(committed.contracts.find((x) => x.id === c.id)).toEqual(c);
    }
    expect(committed).toEqual(fresh);
  });
});

describe('the declarations', () => {
  it('lists every contracts.ts on disk in entry.ts', () => {
    const onDisk = srcRoots()
      .flatMap((root) => filesUnder(root, (name) => name === 'contracts.ts'))
      .filter((file) => !file.includes('/tests/'))
      .sort();
    expect(DECLARED.map((d) => d.file).sort()).toEqual(onDisk);
  });

  it.each(srcRoots())('lists every contract %s declares in its contracts.ts', (root) => {
    const declared = [...declaredConsts(REPO, root).keys()].map((name) => idOfConst(name));
    const listed = DECLARED.filter((d) => srcRootOf(d.file) === root).flatMap((d) =>
      d.contracts.map((c) => c.id),
    );
    expect(listed.sort()).toEqual(declared.sort());
  });

  it('has a test pinning every contract', () => {
    const tests = [
      ...srcRoots().flatMap((root) => filesUnder(root, (name) => name.endsWith('.test.ts'))),
      ...filesUnder('apps/desktop/renderer', (name) => name.endsWith('.test.ts')),
      ...filesUnder('scripts', (name) => name.endsWith('.test.ts')),
    ];
    const pinned = new Set<string>();
    for (const file of tests) {
      for (const m of readFileSync(join(REPO, file), 'utf8').matchAll(/\bpins\((\w+)\)/g)) {
        const id = m[1] ? idOfConst(m[1]) : undefined;
        if (id) pinned.add(id);
      }
    }
    expect(committed.contracts.map((c) => c.id).filter((id) => !pinned.has(id))).toEqual([]);
  });
});

describe('the naming rule', () => {
  it('maps an id to its const and back', () => {
    expect(constNameOf('gate.perUnit')).toBe('gatePerUnit');
    expect(idOfConst('gatePerUnit')).toBe('gate.perUnit');
    expect(constNameOf('Gate.perUnit')).toBeUndefined();
    expect(idOfConst('perunit')).toBeUndefined();
  });
});

describe('buildIndex', () => {
  const facts: Facts = {
    commands        : new Set(['story.assignLineIds']),
    tools           : new Set(['edit_scene']),
    taskKinds       : new Set(['shot_image']),
    slots           : new Set(['shot']),
    commandContracts: [],
    slotContracts   : [],
  };
  // A plain value rather than a declaration, so `declaredConsts` finds no const for it and only
  // the checks under test can fail
  const spec = (subjects: Contract['subjects']): Contract =>
    ({ id: 'script.probe', rule: 'r', prevents: 'p', subjects }) satisfies Contract;
  const problems = (contracts: readonly Contract[]): string => {
    try {
      buildIndex(REPO, [{ file: 'packages/scriptedit/src/contracts.ts', contracts }], facts);
      return '';
    } catch (err) {
      return String(err);
    }
  };

  it('refuses a subject that names nothing, one per prefix', () => {
    const text = problems([
      spec([
        'slot:plate',
        'task:portrait',
        'command:story.nothing',
        'tool:no_such_tool',
        'module:packages/scriptedit/src/nothing.ts',
        'function:packages/scriptedit/src/lineops.ts#nothingHere',
        'package:packages/nothing',
        'file:../escape',
      ]),
    ]);
    for (const subject of [
      'slot:plate',
      'task:portrait',
      'command:story.nothing',
      'tool:no_such_tool',
      'module:packages/scriptedit/src/nothing.ts',
      'function:packages/scriptedit/src/lineops.ts#nothingHere',
      'package:packages/nothing',
      'file:../escape',
    ]) {
      expect(text).toContain(`subject "${subject}"`);
    }
  });

  it('accepts subjects that name real things', () => {
    const text = problems([
      spec([
        'slot:shot',
        'task:shot_image',
        'command:story.assignLineIds',
        'tool:edit_scene',
        'module:packages/scriptedit/src/lineops.ts',
        'function:packages/scriptedit/src/lineops.ts#nextIdOf',
        'package:packages/scriptedit',
        'file:state/tasks.jsonl',
      ]),
    ]);
    expect(text).not.toContain('subject');
    expect(text).toContain('no `export const scriptProbe = contract(`');
  });

  it('refuses one id declared twice', () => {
    const one = spec(['slot:shot']);
    expect(problems([one, { ...one }])).toContain('declared twice');
  });

  it('refuses an id outside the closed set of areas', () => {
    const bad = { ...spec(['slot:shot']), id: 'nowhere.x' } as unknown as Contract;
    expect(problems([bad])).toContain('known area');
  });
});
