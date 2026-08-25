/**
 * `--smoke` checks what a packaged build cannot answer by opening a window: whether the three
 * packages left out of the bundle still resolve, whether the plugin bundler can transform, and
 * whether the source the debug agent reads is in the image.
 *
 * Everything in this app is bundled into `dist/` except three packages. `scripts/aliases.mjs`
 * leaves `@google/genai`, `@anthropic-ai/sdk` and `esbuild` external, and each is reached
 * through a dynamic `import()` at the moment it is first needed. A packaging mistake that loses
 * them (most likely pnpm's symlink farm surviving into the app image) produces an installer that
 * launches, opens a project, and throws `Cannot find module` the first time the agent is asked
 * for anything. Every check short of this one passes.
 *
 * esbuild is checked by running a transform rather than by resolving it, because it drives a
 * binary in a sibling package and finds that binary by a path relative to its own file. A module
 * that resolved while its binary stayed inside the asar would pass a resolution check and fail
 * the first plugin install.
 *
 * The source check has the same shape. `extraResources` and `sourceRoot()` have to agree on one
 * directory name, and when they do not, the app runs correctly and Help ▸ Report a Difficult
 * Agent… refuses the source box — months later, on someone else's machine.
 *
 * The packaged executable does those reads and nothing else. It takes no key, makes no call, and
 * opens no window, because constructing a client is a local act. Whether the key it was handed is
 * any good is `project.testKey`'s question, not this one.
 */
import { sourceRoot } from '@vn/agentreport';

/** The dynamic `import()`, as a parameter — because it is the only part a test cannot run. */
export type Loader = (spec: string) => Promise<unknown>;

export interface SmokeCheck {
  /** What was checked: a module specifier, or `source`. */
  what: string;
  ok: boolean;
  /** One line for a human reading CI output. Never anything that came from a key. */
  detail: string;
}

export interface SmokeReport {
  ok: boolean;
  checks: SmokeCheck[];
}

/**
 * What each SDK is loaded for, mirroring how the two backends in `@vn/providers` pick their
 * constructor off the module — `backends/anthropic.ts` and `backends/gemini.ts`. Those functions
 * need a key and a model id to exist at all, so this mirrors them rather than importing them, and
 * the failure under test is module resolution, which constructing a client proves on its own.
 */
const SDKS: { spec: string; pick: (mod: any) => unknown }[] = [
  { spec: '@anthropic-ai/sdk', pick: (mod) => mod?.default ?? mod },
  { spec: '@google/genai', pick: (mod) => mod?.GoogleGenAI ?? mod?.default },
];

/** The plugin bundler's specifier, which `apps/desktop/src/main/plugins.ts` imports lazily. */
const BUNDLER = 'esbuild';

/**
 * Transform one line of TypeScript with the plugin bundler, which is what proves the binary
 * beside it shipped and can be spawned. The source is a literal, so this reads no file and
 * needs no plugin installed.
 */
async function transformCheck(load: Loader): Promise<SmokeCheck> {
  try {
    const mod = (await load(BUNDLER)) as {
      transform?: (src: string, opts: { loader: string }) => Promise<{ code: string }>;
    };
    if (typeof mod.transform !== 'function') {
      return { what: BUNDLER, ok: false, detail: 'resolved, but exports no transform' };
    }
    const { code } = await mod.transform('const n: number = 1; export default n;', {
      loader: 'ts',
    });
    return code.includes('1')
      ? { what: BUNDLER, ok: true, detail: 'resolved and transformed' }
      : { what: BUNDLER, ok: false, detail: 'transformed to something unexpected' };
  } catch (err) {
    return { what: BUNDLER, ok: false, detail: (err as Error).message };
  }
}

/**
 * Load each SDK and construct one client from it. A resolved module whose constructor is missing
 * counts as a failure: the import having succeeded is not the same as the backend being able to
 * use what it got back.
 */
export async function runSmoke(
  load: Loader,
  findSource: () => Promise<string | undefined> = sourceRoot,
): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  for (const { spec, pick } of SDKS) {
    try {
      const Client = pick(await load(spec)) as
        | (new (opts: { apiKey: string }) => unknown)
        | undefined;
      if (typeof Client !== 'function') {
        checks.push({ what: spec, ok: false, detail: 'resolved, but exports no constructor' });
        continue;
      }
      // A placeholder key, because a constructor that reached out would be a bug in the SDK. It
      // is a literal rather than a real one on purpose: this must run where no key is set.
      new Client({ apiKey: 'smoke-test-not-a-key' });
      checks.push({ what: spec, ok: true, detail: 'resolved and constructed' });
    } catch (err) {
      checks.push({ what: spec, ok: false, detail: (err as Error).message });
    }
  }

  checks.push(await transformCheck(load));

  const root = await findSource().catch(() => undefined);
  checks.push({
    what: 'source',
    ok: root !== undefined,
    detail: root ?? 'not found — the debug agent will refuse to read the source',
  });

  return { ok: checks.every((c) => c.ok), checks };
}

/** The line `scripts/smoke.desktop.mjs` looks for, so the report survives a noisy stdout. */
export const SMOKE_PREFIX = 'VN-SMOKE ';

export function formatSmoke(report: SmokeReport): string {
  return SMOKE_PREFIX + JSON.stringify(report);
}
