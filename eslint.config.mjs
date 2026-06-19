import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat config. Type-aware linting is intentionally NOT enabled here — `tsgo` owns
 * type checking (see `pnpm check`). ESLint enforces correctness-lite rules, import
 * cycles, and the §3 layering graph; stylistic rules defer to Prettier.
 */

// The acyclic dependency graph from docs/plans/initial-implementation.md §3.
// Each package may import ONLY the packages listed here (plus externals).
const ALLOWED = {
  types: [],
  util: ['types'],
  config: ['types', 'util'],
  parse: ['types', 'util'],
  model: ['types', 'util', 'parse'],
  store: ['types', 'util', 'parse'],
  git: ['util'],
  taskgraph: ['types', 'util', 'store'],
  providers: ['types', 'util', 'config'],
  pipeline: ['types', 'util', 'config', 'model', 'store', 'taskgraph', 'providers'],
  scheduler: ['types', 'util', 'taskgraph', 'pipeline'],
  // Input-side agent core: reuses the deterministic packages + the LLM seam, and is
  // forbidden from importing the generative pipeline/scheduler (authoring-agent plan §4).
  authoring: ['types', 'util', 'config', 'parse', 'model', 'store', 'providers', 'git'],
  // The interactive REPL: input-side only. Forbidden from the generative pipeline/scheduler
  // (authoring-agent plan §4, §M4) — enforced here, not just documented.
  'authoring-app': ['types', 'util', 'config', 'store', 'providers', 'git', 'authoring'],
  cli: [
    'types',
    'util',
    'config',
    'parse',
    'model',
    'store',
    'taskgraph',
    'providers',
    'pipeline',
    'scheduler',
  ],
  // The Electron desktop app is the JOIN POINT above both branches: it embeds the authoring
  // agent AND the generative scheduler/pipeline in one process and streams them to the
  // renderer over IPC. It is the *only* element allowed to import both sides — authoring
  // itself stays forbidden from the pipeline (see the `authoring` entry above).
  desktop: [
    'types',
    'util',
    'config',
    'parse',
    'model',
    'store',
    'git',
    'taskgraph',
    'providers',
    'pipeline',
    'scheduler',
    'authoring',
  ],
};

const boundaryRules = Object.entries(ALLOWED).map(([from, allow]) => ({
  from,
  allow: [from, ...allow],
}));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tmp-*', 'apps/*/dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Build scripts / config files run in Node (ESM or CJS), outside the TS project.
  {
    files: ['**/*.mjs', '**/*.cjs', '*.config.*', 'scripts/**'],
    languageOptions: {
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    plugins: { import: importPlugin, boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'types', pattern: 'packages/types', mode: 'folder' },
        { type: 'util', pattern: 'packages/util', mode: 'folder' },
        { type: 'config', pattern: 'packages/config', mode: 'folder' },
        { type: 'parse', pattern: 'packages/parse', mode: 'folder' },
        { type: 'model', pattern: 'packages/model', mode: 'folder' },
        { type: 'store', pattern: 'packages/store', mode: 'folder' },
        { type: 'git', pattern: 'packages/git', mode: 'folder' },
        { type: 'authoring', pattern: 'packages/authoring', mode: 'folder' },
        { type: 'taskgraph', pattern: 'packages/taskgraph', mode: 'folder' },
        { type: 'providers', pattern: 'packages/providers', mode: 'folder' },
        { type: 'pipeline', pattern: 'packages/pipeline', mode: 'folder' },
        { type: 'scheduler', pattern: 'packages/scheduler', mode: 'folder' },
        { type: 'cli', pattern: 'apps/cli', mode: 'folder' },
        { type: 'authoring-app', pattern: 'apps/authoring', mode: 'folder' },
      ],
      'boundaries/dependency-nodes': ['import', 'dynamic-import'],
      'import/resolver': { node: true },
    },
    rules: {
      'import/no-cycle': 'error',
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: boundaryRules,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/__fixtures__/**'],
    rules: { 'boundaries/element-types': 'off' },
  },
);
