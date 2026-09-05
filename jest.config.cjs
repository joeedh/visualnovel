/**
 * Root jest config (plan §5). One project per package with a display name, so
 * `jest --selectProjects @vn/taskgraph` runs a single package's suite. Tests are
 * transpiled through esbuild to match the bundler; the generative SDKs are mocked
 * behind the `@vn/types` interfaces.
 *
 * NOTE: the plan lists `jest.config.ts`; this uses `.cjs` to avoid bootstrapping
 * ts-node just to read the config. Behavior is identical.
 */
const PACKAGES = [
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
  'agentreport',
  'debug2d',
  'authoring',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
  'testkit',
  'gengraph',
];

/** @type {import('jest').Config} */
const shared = {
  testEnvironment         : 'node',
  // The `.js` half covers path.ux's vendored ESM (lz-string, reached through toolprop),
  // which node cannot require and jest would otherwise hand to its runtime untransformed.
  // node_modules stays out of it through jest's default transformIgnorePatterns.
  transform: {
    '^.+\\.tsx?$': '<rootDir>/scripts/jest-esbuild.cjs',
    '^.+\\.m?js$': '<rootDir>/scripts/jest-esbuild.cjs',
  },
  // Points $VNAUTHOR_HOME somewhere empty, so a test that resolves keys cannot read the
  // developer's own. See the file for why the default has to be on for everything else.
  setupFiles              : ['<rootDir>/scripts/jest-setup.cjs'],
  // Raises the per-test timeout; see the file for why it is not a `testTimeout` key.
  setupFilesAfterEnv      : ['<rootDir>/scripts/jest-timeout.cjs'],
  moduleFileExtensions    : ['ts', 'tsx', 'js', 'json'],
  // Linked worktrees under .claude/worktrees, the source snapshot
  // `scripts/package.desktop.mjs` stages for the installer, and the app image
  // electron-builder writes that snapshot into each contain full copies of every
  // package.json, which the haste map indexes regardless of testMatch, producing
  // "duplicate @vn/x" errors. Excluded here rather than moved into `roots`, since
  // roots is scoped by directory and the crawl still needs to reach `packages/`
  // and `apps/` at the repo root.
  modulePathIgnorePatterns: [
    '<rootDir>/.claude/worktrees',
    '<rootDir>/apps/desktop/.package',
    '<rootDir>/apps/desktop/release',
  ],
  moduleNameMapper: {
    // Strip the explicit .js extension used in source so jest resolves the .ts file.
    '^(\\.{1,2}/.*)\\.js$' : '$1',
    // Workspace packages resolve straight to source.
    '^@vn/cli$'            : '<rootDir>/apps/cli/src/index.ts',
    '^@vn/([^/]+)$'        : '<rootDir>/packages/$1/src/index.ts',
    // A subpath export names its source file: `@vn/scriptedit/write` → `src/write.ts`.
    '^@vn/([^/]+)/([^/]+)$': '<rootDir>/packages/$1/src/$2.ts',
    // @vn/gengraph's door to path.ux's graph module and the ToolProperty classes node
    // specs are authored with; source here, declarations in the root tsconfig's paths.
    '^pathux-graph$'       : '<rootDir>/vendor/path.ux/scripts/graph/index.ts',
    '^pathux-toolprop$'    : '<rootDir>/vendor/path.ux/scripts/path-controller/toolsys/toolprop.ts',
    '^pathux-base-types$'  : '<rootDir>/vendor/path.ux/scripts/core/base/ui_base_types.ts',
    // nstructjs names an ESM bundle as its `main`, which this CJS runner cannot load; the
    // same build ships beside it in CommonJS. Shared because both the desktop app and
    // @vn/gengraph depend on it, always as the `vendor/nstructjs` submodule.
    '^nstructjs$'          : '<rootDir>/vendor/nstructjs/build/nstructjs-jest.js',
  },
};

module.exports = {
  projects: [
    ...PACKAGES.map((name) => ({
      ...shared,
      displayName: `@vn/${name}`,
      rootDir    : __dirname,
      // Tests live in a `tests/` subfolder beside the code they cover. No
      // <rootDir> prefix: jest's glob path-separator conversion breaks on
      // dot-directories in the path (e.g. .claude/worktrees). Crawling is still
      // scoped to rootDir via `roots`.
      testMatch  : [`**/packages/${name}/**/tests/*.test.ts`],
    })),
    {
      ...shared,
      displayName: '@vn/cli',
      rootDir    : __dirname,
      testMatch  : ['**/apps/cli/**/tests/*.test.ts'],
    },
    // Repository tooling, outside the package layering graph. Spreads `shared` like every
    // other project: without it a `.ts` test gets no esbuild transform and no `.js`-extension
    // stripping, and nothing runs.
    {
      ...shared,
      displayName: 'scripts',
      rootDir    : __dirname,
      testMatch  : ['**/scripts/**/tests/*.test.ts'],
    },
    {
      ...shared,
      displayName: '@vn/authoring-app',
      rootDir    : __dirname,
      testMatch  : ['**/apps/authoring/**/tests/*.test.ts'],
    },
    {
      ...shared,
      displayName     : '@vn/desktop',
      rootDir         : __dirname,
      testMatch       : ['**/apps/desktop/**/tests/*.test.ts'],
      moduleNameMapper: {
        // Before the `.js`-stripping rule, which would otherwise never see it: a renderer module
        // that adopts a stylesheet must still be importable by a node-only test.
        '\\.css\\?inline$': '<rootDir>/scripts/jest-css-inline.cjs',
        ...shared.moduleNameMapper,
      },
    },
  ],
};
