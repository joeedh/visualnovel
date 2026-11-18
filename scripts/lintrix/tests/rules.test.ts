// Runs the real lintrix CLI over a throwaway workspace, because the plugin only loads
// under Node's ESM loader and jest's runtime here is CommonJS.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO, 'node_modules/lintrix/dist/ts/cli.js');
const PLUGIN = path.join(REPO, 'scripts/lintrix/index.ts');

interface Problem {
  file: string;
  line: number;
  ruleId: string;
  message: string;
}

let root: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Lints the workspace and returns the plugin's problems, sorted by file and line. */
function lintAll(): Problem[] {
  const run = spawnSync(process.execPath, [CLI, '--format', 'json', '.'], {
    cwd     : root,
    encoding: 'utf8',
  });
  if (run.status !== 0 && run.status !== 1) throw new Error(run.stderr || run.stdout);
  const reports = JSON.parse(run.stdout) as {
    filePath: string;
    messages: { line: number; ruleId: string; message: string }[];
  }[];
  return reports
    .flatMap((r) =>
      r.messages.map((m) => ({
        file   : path.relative(root, r.filePath).replace(/\\/g, '/'),
        line   : m.line,
        ruleId : m.ruleId,
        message: m.message,
      })),
    )
    .filter((p) => p.ruleId.startsWith('vn/'))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-lintrix-'));
  write(
    'lintrix.config.json',
    JSON.stringify({
      plugins: { vn: PLUGIN },
      rules: {
        'vn/no-cycle'     : 'error',
        'vn/element-types': [
          'error',
          {
            elements: { low: 'packages/low', high: 'packages/high', shared: 'packages/shared' },
            allow   : { high: ['low', 'shared'], low: [] },
          },
        ],
      },
    }),
  );
  write(
    'tsconfig.json',
    // Comments and a trailing comma, as tsconfig allows.
    `{
      // aliases
      "compilerOptions": { "paths": { "@x/low": ["./packages/low/src/index.ts"], } },
    }`,
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('vn/element-types', () => {
  it('refuses an import its allow entry does not list, in every import form', () => {
    write('packages/low/src/index.ts', 'export const low = 1;\n');
    write(
      'packages/high/src/index.ts',
      "import { low } from '@x/low';\nexport const high = low;\n",
    );
    write(
      'packages/low/src/bad.ts',
      [
        "import { high } from '../../high/src/index.js';",
        "import type { Thing } from '../../high/src/index.js';",
        "export * from '../../high/src/index.js';",
        "export const later = () => import('../../high/src/index.js');",
        "import fs from 'node:fs';",
        'export const x = [high, fs];',
        'export type T = Thing;',
      ].join('\n'),
    );
    expect(lintAll().map((p) => [p.file, p.line, p.ruleId])).toEqual([
      ['packages/low/src/bad.ts', 1, 'vn/element-types'],
      ['packages/low/src/bad.ts', 2, 'vn/element-types'],
      ['packages/low/src/bad.ts', 3, 'vn/element-types'],
      ['packages/low/src/bad.ts', 4, 'vn/element-types'],
    ]);
  });

  it('follows a workspace package through its node_modules link and exports map', () => {
    write(
      'packages/shared/package.json',
      JSON.stringify({ name: '@x/shared', exports: { './sub': './src/sub.ts' } }),
    );
    write('packages/shared/src/sub.ts', 'export const s = 1;\n');
    fs.mkdirSync(path.join(root, 'packages/low/node_modules/@x'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'packages/shared'),
      path.join(root, 'packages/low/node_modules/@x/shared'),
      'junction',
    );
    write('packages/low/src/index.ts', "import { s } from '@x/shared/sub';\nexport const l = s;\n");
    const problems = lintAll();
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("'low' may not import 'shared'"),
    ]);
  });

  it('treats an element naming one file as its own element, inside its folder’s', () => {
    write(
      'lintrix.config.json',
      JSON.stringify({
        plugins: { vn: PLUGIN },
        rules: {
          'vn/element-types': [
            'error',
            {
              elements: {
                low     : 'packages/low',
                lowWrite: 'packages/low/src/write.ts',
                high    : 'packages/high',
                other   : 'packages/other',
              },
              allow   : { low: [], lowWrite: ['low'], high: ['low', 'lowWrite'], other: ['low'] },
            },
          ],
        },
      }),
    );
    write('packages/low/src/index.ts', 'export const low = 1;\n');
    write('packages/low/src/writer.ts', 'export const writer = 1;\n');
    write(
      'packages/low/src/write.ts',
      "import { low } from './index.js';\nexport const write = low;\n",
    );
    write(
      'packages/low/src/uses.ts',
      "import { write } from './write.js';\nexport const uses = write;\n",
    );
    write(
      'packages/high/src/index.ts',
      "import { write } from '../../low/src/write.js';\nexport const high = write;\n",
    );
    write(
      'packages/other/src/index.ts',
      [
        "import { writer } from '../../low/src/writer.js';",
        "import { write } from '../../low/src/write.js';",
        'export const other = [writer, write];',
      ].join('\n'),
    );
    expect(lintAll().map((p) => [p.file, p.line, p.message])).toEqual([
      ['packages/low/src/uses.ts', 1, expect.stringContaining("'low' may not import 'lowWrite'")],
      [
        'packages/other/src/index.ts',
        2,
        expect.stringContaining("'other' may not import 'lowWrite'"),
      ],
    ]);
  });
});

describe('vn/no-cycle', () => {
  it('reports each import that enters a cycle, naming the chain', () => {
    write('packages/low/src/a.ts', "import { b } from './b.js';\nexport const a = () => b;\n");
    write('packages/low/src/b.ts', "export { c as b } from './c.js';\n");
    write('packages/low/src/c.ts', "import { a } from './a.js';\nexport const c = () => a;\n");
    const problems = lintAll();
    expect(problems.map((p) => [p.file, p.line])).toEqual([
      ['packages/low/src/a.ts', 1],
      ['packages/low/src/b.ts', 1],
      ['packages/low/src/c.ts', 1],
    ]);
    expect(problems[0]?.message).toBe(
      'Import cycle: packages/low/src/a.ts → packages/low/src/b.ts → packages/low/src/c.ts → ' +
        'packages/low/src/a.ts.',
    );
  });

  it('counts a dynamic import, but not an import erased as type-only', () => {
    write('packages/low/src/a.ts', "export const a = () => import('./b.js');\n");
    write('packages/low/src/b.ts', "import { a } from './a.js';\nexport const b = a;\n");
    write('packages/low/src/t1.ts', "import type { T2 } from './t2.js';\nexport type T1 = T2;\n");
    write('packages/low/src/t2.ts', "import { type T1 } from './t1.js';\nexport type T2 = T1;\n");
    write('packages/low/src/t3.ts', "import { t4 } from './t4.js';\nexport const t3 = t4;\n");
    write('packages/low/src/t4.ts', "export type { T3 } from './t3.js';\nexport const t4 = 1;\n");
    expect(lintAll().map((p) => p.file)).toEqual([
      'packages/low/src/a.ts',
      'packages/low/src/b.ts',
    ]);
  });
});

/** Rewrites the config so only the two contract rules run. */
function contractRules(): void {
  write(
    'lintrix.config.json',
    JSON.stringify({
      plugins: { vn: PLUGIN },
      rules  : { 'vn/contract-decl': 'error', 'vn/contract-pins': 'error' },
    }),
  );
}

describe('vn/contract-decl', () => {
  it('accepts an exported const named from its literal id, with short literal fields', () => {
    contractRules();
    write(
      'packages/low/src/rule.ts',
      [
        "import { contract } from '@vn/contracts';",
        'export const gatePerUnit = contract({',
        "  id: 'gate.perUnit',",
        "  rule: 'A unit waits for its gate.',",
        "  prevents: 'Paying for a cast that may change.',",
        "  subjects: ['module:packages/low/src/rule.ts'],",
        '});',
      ].join('\n'),
    );
    expect(lintAll()).toEqual([]);
  });

  it('refuses a misnamed, unexported, computed or overlong declaration', () => {
    contractRules();
    const long = 'x'.repeat(281);
    write(
      'packages/low/src/bad.ts',
      [
        "import { contract } from '@vn/contracts';",
        "export const perUnit = contract({ id: 'gate.perUnit', rule: 'r', prevents: 'p', subjects: [] });",
        "const hidden = contract({ id: 'gate.hidden', rule: 'r', prevents: 'p', subjects: [] });",
        "const area = 'gate';",
        "export const gateMade = contract({ id: `${area}.made`, rule: 'r', prevents: 'p', subjects: [] });",
        `export const gateLong = contract({ id: 'gate.long', rule: '${long}', prevents: 'p' + 'q', subjects: [] });`,
        'export const used = [hidden];',
      ].join('\n'),
    );
    expect(lintAll().map((p) => [p.line, p.message])).toEqual([
      [2, expect.stringContaining('must be declared as `gatePerUnit`, not `perUnit`')],
      [3, expect.stringContaining('export const')],
      [5, expect.stringContaining('`id` must be a string literal')],
      [6, expect.stringContaining('`rule` is 281 characters')],
      [6, expect.stringContaining('`prevents` must be a string literal')],
    ]);
  });

  it('refuses a declaration outside a package or app source, and in a test', () => {
    contractRules();
    const decl = [
      "import { contract } from '@vn/contracts';",
      "export const gateX = contract({ id: 'gate.x', rule: 'r', prevents: 'p', subjects: [] });",
    ].join('\n');
    write('scripts/x.ts', decl);
    write('packages/low/src/tests/x.test.ts', decl);
    write('packages/low/src/tests/helper.ts', decl);
    expect(lintAll().map((p) => p.file)).toEqual([
      'packages/low/src/tests/helper.ts',
      'packages/low/src/tests/x.test.ts',
      'scripts/x.ts',
    ]);
  });
});

describe('vn/contract-pins', () => {
  it('takes an identifier imported under its own name, and nothing else', () => {
    contractRules();
    write(
      'packages/low/src/tests/pinned.test.ts',
      [
        "import { pins } from '@vn/contracts';",
        "import { gatePerUnit, gateOther as other } from '../rule.js';",
        'const local = gatePerUnit;',
        'describe(pins(gatePerUnit), () => {});',
        'describe(pins(other), () => {});',
        'describe(pins(local), () => {});',
        'describe(pins(gatePerUnit, gatePerUnit), () => {});',
      ].join('\n'),
    );
    expect(lintAll().map((p) => p.line)).toEqual([5, 6, 7]);
  });
});
