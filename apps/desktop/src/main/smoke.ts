/**
 * `--smoke`: the one question a packaged build cannot answer by opening a window.
 *
 * Everything in this app is bundled into `dist/` except two things. `scripts/aliases.mjs` leaves
 * `@google/genai` and `@anthropic-ai/sdk` external, and both are reached through a dynamic
 * `import()` at the moment a model is first called — so a packaging mistake that loses them (the
 * likely one being pnpm's symlink farm surviving into the app image) produces an installer that
 * launches, opens a project, and throws `Cannot find module` the first time the agent is asked
 * for anything. Every check short of this one passes.
 *
 * So the packaged executable can be asked to do exactly that import and nothing else. It takes no
 * key, makes no call, and opens no window: constructing a client is a local act, and whether the
 * key it was handed is any good is `project.testKey`'s question, not this one.
 */

/** The dynamic `import()`, as a parameter — because it is the only part a test cannot run. */
export type Loader = (spec: string) => Promise<unknown>;

export interface SmokeCheck {
  spec: string;
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
 * constructor off the module — `backends/anthropic.ts` and `backends/gemini.ts`. The mirror is
 * deliberate rather than an import: those functions need a key and a model id to exist at all,
 * and the failure under test is module resolution, which a constructor proves on its own.
 */
const SDKS: { spec: string; pick: (mod: any) => unknown }[] = [
  { spec: '@anthropic-ai/sdk', pick: (mod) => mod?.default ?? mod },
  { spec: '@google/genai', pick: (mod) => mod?.GoogleGenAI ?? mod?.default },
];

/**
 * Load each SDK and construct one client from it. A resolved module whose constructor is missing
 * counts as a failure: the import having succeeded is not the same as the backend being able to
 * use what it got back.
 */
export async function runSmoke(load: Loader): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  for (const { spec, pick } of SDKS) {
    try {
      const Client = pick(await load(spec)) as
        | (new (opts: { apiKey: string }) => unknown)
        | undefined;
      if (typeof Client !== 'function') {
        checks.push({ spec, ok: false, detail: 'resolved, but exports no constructor' });
        continue;
      }
      // A placeholder key, because a constructor that reached out would be a bug in the SDK. It
      // is a literal rather than a real one on purpose: this must run where no key is set.
      new Client({ apiKey: 'smoke-test-not-a-key' });
      checks.push({ spec, ok: true, detail: 'resolved and constructed' });
    } catch (err) {
      checks.push({ spec, ok: false, detail: (err as Error).message });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/** The line `scripts/smoke.desktop.mjs` looks for, so the report survives a noisy stdout. */
export const SMOKE_PREFIX = 'VN-SMOKE ';

export function formatSmoke(report: SmokeReport): string {
  return SMOKE_PREFIX + JSON.stringify(report);
}
