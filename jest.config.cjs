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
  'git',
  'authoring',
  'taskgraph',
  'providers',
  'pipeline',
  'scheduler',
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
  },
};

module.exports = {
  projects: [
    ...PACKAGES.map((name) => ({
      ...shared,
      displayName: `@vn/${name}`,
      rootDir: __dirname,
      testMatch: [`<rootDir>/packages/${name}/**/*.test.ts`],
    })),
    {
      ...shared,
      displayName: '@vn/cli',
      rootDir: __dirname,
      testMatch: ['<rootDir>/apps/cli/**/*.test.ts'],
    },
    {
      ...shared,
      displayName: '@vn/authoring-app',
      rootDir: __dirname,
      testMatch: ['<rootDir>/apps/authoring/**/*.test.ts'],
    },
  ],
};
