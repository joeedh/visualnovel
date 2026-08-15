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
  'debug2d',
  'authoring',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
  'testkit',
];

/** @type {import('jest').Config} */
const shared = {
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': '<rootDir>/scripts/jest-esbuild.cjs' },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    // Strip the explicit .js extension used in source so jest resolves the .ts file.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Workspace packages resolve straight to source.
    '^@vn/cli$': '<rootDir>/apps/cli/src/index.ts',
    '^@vn/([^/]+)$': '<rootDir>/packages/$1/src/index.ts',
    // A subpath export names its source file: `@vn/scriptedit/write` → `src/write.ts`.
    '^@vn/([^/]+)/([^/]+)$': '<rootDir>/packages/$1/src/$2.ts',
  },
};

module.exports = {
  projects: [
    ...PACKAGES.map((name) => ({
      ...shared,
      displayName: `@vn/${name}`,
      rootDir: __dirname,
      // Tests live in a `tests/` subfolder beside the code they cover. No
      // <rootDir> prefix: jest's glob path-separator conversion breaks on
      // dot-directories in the path (e.g. .claude/worktrees). Crawling is still
      // scoped to rootDir via `roots`.
      testMatch: [`**/packages/${name}/**/tests/*.test.ts`],
    })),
    {
      ...shared,
      displayName: '@vn/cli',
      rootDir: __dirname,
      testMatch: ['**/apps/cli/**/tests/*.test.ts'],
    },
    {
      ...shared,
      displayName: '@vn/authoring-app',
      rootDir: __dirname,
      testMatch: ['**/apps/authoring/**/tests/*.test.ts'],
    },
    {
      ...shared,
      displayName: '@vn/desktop',
      rootDir: __dirname,
      testMatch: ['**/apps/desktop/**/tests/*.test.ts'],
      moduleNameMapper: {
        ...shared.moduleNameMapper,
        // nstructjs names an ESM bundle as its `main`, which this CJS runner cannot load; the
        // same build ships beside it in CommonJS. Only the desktop app depends on it.
        '^nstructjs$': '<rootDir>/apps/desktop/node_modules/nstructjs/build/_nstructjs.js',
      },
    },
  ],
};
