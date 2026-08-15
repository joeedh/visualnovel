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
  // Leaf exporter: manifest → playable projection. Reuses the input-side + store packages;
  // forbidden from the generative pipeline/scheduler (runner plan, Part B), like `authoring`.
  export: ['types', 'util', 'parse', 'model', 'store'],
  // Scene-edit rules + the write path that applies them. Same allow-list as `export`, and
  // input-side for the same reason: it decides and patches authored prose, and must be
  // importable by BOTH the desktop app and `authoring` — which is why it cannot live in
  // either (scene-edit-package plan).
  scriptedit: ['types', 'util', 'parse', 'model', 'store'],
  // Retrieval over the story bible. Input-side leaf like `export`/`scriptedit` — the desktop
  // app and `authoring` both search the wiki, so the ranking policy lives in neither, and it
  // is forbidden from the generative pipeline/scheduler (story-bible-and-retrieval plan).
  bible: ['types', 'util', 'parse', 'store'],
  // Art-generation policy: the prompt builders every planned image derives from, plus the
  // on-demand `concept` door and its promotion to a plate. A leaf for the same reason as the
  // three above — the pipeline, the desktop app and `authoring` all need it, and `authoring`
  // cannot import the pipeline. `taskgraph` is here so promotion can mint the planner's own task
  // identity; that reach stays inside this package, since boundaries are per-import.
  artgen: ['types', 'util', 'config', 'parse', 'model', 'store', 'taskgraph', 'providers'],
  git: ['util'],
  // The command framework: registry, prop specs, DSL, stack. Reads git HEAD for provenance,
  // knows nothing about the domain — commands themselves are defined by the host app.
  commands: ['types', 'util', 'git'],
  // 2D debug layer: sits OUTSIDE the layering graph — imports nothing from packages/ and is
  // imported only by the desktop renderer. Must stay strippable from production builds.
  debug2d: [],
  taskgraph: ['types', 'util', 'store'],
  providers: ['types', 'util', 'config'],
  pipeline: ['types', 'util', 'config', 'model', 'store', 'taskgraph', 'providers', 'artgen'],
  // `config` and `store` are pass-through only: the scheduler takes a `ProjectConfig` and a
  // `ProjectPaths` in `RunOptions` and hands them to `@vn/pipeline`, which owns both.
  scheduler: ['types', 'util', 'config', 'store', 'taskgraph', 'pipeline'],
  // Test-only fixture builder: composes every layer to build real projects on disk, so it may
  // import anything. Nothing may import IT — no rule grants that, and the default is
  // `disallow`, so production code reaching for testkit is a lint error. Tests are exempt via
  // the `**/*.test.ts` override below, which is the only place testkit belongs.
  testkit: [
    'types',
    'util',
    'config',
    'parse',
    'model',
    'store',
    'export',
    'git',
    'commands',
    'taskgraph',
    'providers',
    'pipeline',
    'scheduler',
  ],
  // Input-side agent core: reuses the deterministic packages + the LLM seam, and is
  // forbidden from importing the generative pipeline/scheduler (authoring-agent plan §4).
  authoring: [
    'types',
    'util',
    'config',
    'parse',
    'model',
    'store',
    'scriptedit',
    'bible',
    'artgen',
    'providers',
    'git',
  ],
  // The interactive REPL: input-side only. Forbidden from the generative pipeline/scheduler
  // (authoring-agent plan §4, §M4) — enforced here, not just documented.
  'authoring-app': ['types', 'util', 'config', 'store', 'artgen', 'providers', 'git', 'authoring'],
  cli: [
    'types',
    'util',
    'config',
    'parse',
    'model',
    'store',
    'export',
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
    'export',
    'scriptedit',
    'bible',
    'artgen',
    'git',
    'commands',
    'taskgraph',
    'providers',
    'pipeline',
    'scheduler',
    'authoring',
    'debug2d',
  ],
};

const boundaryRules = Object.entries(ALLOWED).map(([from, allow]) => ({
  from,
  allow: [from, ...allow],
}));

export default tseslint.config(
  {
    // `vendor/**` is submodules — path.ux lints in its own repo, under its own rules.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tmp-*',
      'apps/*/dist/**',
      'coverage/**',
      'vendor/**',
    ],
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
        fetch: 'readonly',
        setTimeout: 'readonly',
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
        { type: 'export', pattern: 'packages/export', mode: 'folder' },
        { type: 'scriptedit', pattern: 'packages/scriptedit', mode: 'folder' },
        { type: 'bible', pattern: 'packages/bible', mode: 'folder' },
        { type: 'artgen', pattern: 'packages/artgen', mode: 'folder' },
        { type: 'git', pattern: 'packages/git', mode: 'folder' },
        { type: 'commands', pattern: 'packages/commands', mode: 'folder' },
        { type: 'debug2d', pattern: 'packages/debug2d', mode: 'folder' },
        { type: 'authoring', pattern: 'packages/authoring', mode: 'folder' },
        { type: 'taskgraph', pattern: 'packages/taskgraph', mode: 'folder' },
        { type: 'providers', pattern: 'packages/providers', mode: 'folder' },
        { type: 'pipeline', pattern: 'packages/pipeline', mode: 'folder' },
        { type: 'scheduler', pattern: 'packages/scheduler', mode: 'folder' },
        { type: 'testkit', pattern: 'packages/testkit', mode: 'folder' },
        { type: 'cli', pattern: 'apps/cli', mode: 'folder' },
        { type: 'authoring-app', pattern: 'apps/authoring', mode: 'folder' },
        { type: 'desktop', pattern: 'apps/desktop', mode: 'folder' },
      ],
      'boundaries/dependency-nodes': ['import', 'dynamic-import'],
      /**
       * The TypeScript resolver, not the node one. Internal packages are source-only —
       * `@vn/x` has an `exports` map pointing at `src/index.ts` and no `main` — which the
       * legacy node resolver cannot follow. It resolved nothing, and an unresolved import is
       * an UNCLASSIFIED one, so `boundaries/element-types` silently passed every cross-layer
       * import. This reads the root tsconfig's `paths`, so the layering below is real.
       */
      'import/resolver': {
        typescript: { project: './tsconfig.json', alwaysTryTypes: true },
      },
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
