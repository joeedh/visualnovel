import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import preferConstructElement from './vendor/path.ux/buildtools/eslint-rules/prefer-construct-element.mjs';
// import validDatapath from "path.ux/eslint/valid-datapath";
// import validThemeKey from "path.ux/eslint/valid-theme-key";

/**
 * Flat config. Type-aware linting is intentionally NOT enabled here — `tsgo` owns
 * type checking (see `pnpm check`). ESLint enforces correctness-lite rules; stylistic rules defer to Prettier.
 * The layering graph and import cycles moved to lintrix (`scripts/lintrix/`).
 */

export default tseslint.config(
  {
    // `vendor/**` is submodules — path.ux lints in its own repo, under its own rules.
    // `.claude/worktrees/**` is a second checkout of this same repo, and
    // `apps/desktop/.package/**` holds a staged copy of the source the installer ships: flat
    // config reads neither `.gitignore` nor `.prettierignore`, so without these `eslint .` from
    // here lints every branch anyone has open plus a duplicate of the whole workspace, and a lint
    // error in either fails the run on master.
    ignores: [
      '**/dist/**',
      '**/vendor/**',
      '**/win-unpacked/**',
      '**/apps/desktop/.package/**',
      '**/node_modules/**',
      '**/*.tmp-*',
      'apps/*/dist/**',
      'apps/desktop/.package/**',
      // The esbuild bundle `scripts/prose-style.mjs` writes beside the SDK it resolves. It is
      // removed on a clean exit, but a killed run leaves one behind, and flat config does not
      // read .gitignore.
      'apps/desktop/.prosestyle-entry.*.cjs',
      // The app image electron-builder writes, which holds a copy of this repo's own sources as
      // the debug agent's source snapshot. Linting those lints every file twice, and the copy
      // under `resources/source/scripts` is read with none of the overrides below applied.
      'apps/desktop/release/**',
      'coverage/**',
      'vendor/**',
      '.claude/worktrees/**',
      // The page builder the desktop app commits into a project is generated output; it
      // carries its own eslint-disable, and this keeps an older copy in examples/ quiet too.
      '**/.vnstudio/pages/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Build scripts / config files run in Node (ESM or CJS), outside the TS project.
  {
    files          : ['**/*.mjs', '**/*.cjs', '*.config.*', 'scripts/**'],
    languageOptions: {
      globals: {
        process        : 'readonly',
        __dirname      : 'readonly',
        module         : 'writable',
        require        : 'readonly',
        console        : 'readonly',
        fetch          : 'readonly',
        setTimeout     : 'readonly',
        clearTimeout   : 'readonly',
        AbortController: 'readonly',
        URL            : 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // The one script that runs inside jest rather than beside it, so it sees the framework's
  // globals. A `.test.ts` file needs no such entry: typescript-eslint turns `no-undef` off.
  {
    files          : ['scripts/jest-timeout.cjs'],
    languageOptions: { globals: { jest: 'readonly' } },
  },
  // Repository tooling, given the same `^_` relaxation as packages and apps below
  {
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // An editor reaches a command through `bridge.exec` and nowhere else. The bridge is what
  // `onExec`, `onInvalidate` and `onWrote` hang off, so a pane that invokes the channel itself
  // writes the file and tells no other pane about it. There is no legitimate exception here, so
  // the rule carries no allowlist.
  {
    files: ['apps/desktop/renderer/pathux/editors/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='invoke'] > Literal[value='command:exec']",
          message:
            "Run the command through `exec` from '../bridge.js' instead of invoking 'command:exec'.",
        },
      ],
    },
  },
  {
    plugins: {
      pathux: {
        rules: {
          'prefer-construct-element': preferConstructElement,
          // "valid-datapath": validDatapath,
          // "valid-theme-key": validThemeKey,
        },
      },
    },
    rules: {
      // Options, both optional: "suffix" is the tag suffix that marks a path.ux
      // custom element (default "-x"), and "allow" lists tags to leave alone --
      // one you create uninitialized on purpose and hand to something that
      // calls checkInit() later.
      'pathux/prefer-construct-element': ['error', { suffix: '-x', allow: [] }],

      // Checks container.prop("...") strings against a catalog your app
      // generates by walking its own defineAPI(). Point "catalogPath" at that
      // file (or export PATHUX_DATAPATH_CATALOG); left unset it falls back to
      // path.ux's own generated/api-paths.json, which does not know your app's
      // paths. Best run as a warning until the catalog covers every path the
      // app resolves.
      // "pathux/valid-datapath": ["warn", { catalogPath: "./generated/api-paths.json" }],

      // Flags literal getDefault("...") keys that are in no class of the theme
      // catalog. It takes no options and reads path.ux's own
      // generated/themes.json (pnpm run gen:themes, inside the library), so it
      // catches typos in library theme keys but not in keys your own widgets
      // add. Opt-in: the catalog is a floor, not a closed set.
      // "pathux/valid-theme-key": "warn",
    },
  },
);
