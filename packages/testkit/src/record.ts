/**
 * Record and audit the fixture asset corpus. Driven by `scripts/record-fixture-assets.mjs`;
 * it lives here rather than in the script so it is typechecked and inside the layering graph.
 *
 * Only the image backend is real; text and vision stay mocked. P5 shot decomposition is an LLM
 * step, so a recording made against a real text model would carry shot descriptions no replaying
 * fixture asks for again, every image prompt downstream would miss, and the corpus would be dead
 * bytes. Mocking text pins the run to the deterministic baseline decomposition, which is what a
 * replay produces. The cost is that a recorded P7 loop is one attempt deep.
 *
 * Plan: `docs/plans/archive/sample-workspace-and-asset-cache.md`.
 */
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import type { AnyTask, AssetCacheEntry, Logger } from '@vn/types';
import {
  AssetCache,
  CachedImageBackend,
  StubImageBackend,
  createGeminiImage,
  createMockProviders,
  type ImageBackend,
  type ServedRequest,
} from '@vn/providers';
import { FIXTURE_ASSET_DIR } from './assets.js';
import { makeProject, type TestProject } from './project.js';
import { SCRIPTS } from './scripts.js';

export type FixtureName = keyof typeof SCRIPTS;

export interface CorpusOptions {
  /** Which `SCRIPTS` entry to build. Default `linear` — the smallest runnable fixture. */
  fixture?: FixtureName;
  /** Override the corpus directory. Default `packages/testkit/assets`. */
  cacheDir?: string;
  log?: (line: string) => void;
}

export interface CorpusReport {
  fixture: FixtureName;
  /** Requests the cache answered. */
  reused: number;
  /** Requests that fell through — written back only on a recording run. */
  missed: number;
  /** Newly written entries. Always 0 for `checkCorpus`. */
  added: number;
  /** Indexed entries the run never asked for. */
  orphaned: AssetCacheEntry[];
  /** Indexed entries whose bytes are gone. */
  missingFiles: AssetCacheEntry[];
  /** Entries the corpus holds after the run. */
  entries: number;
  /** Total recorded size, in bytes. */
  totalBytes: number;
  /** Tasks that ended `failed`. A recording run that hit one recorded less than it was asked to. */
  failed: FailedTask[];
}

export interface FailedTask {
  kind: string;
  error: string;
}

const noop = () => undefined;

/**
 * Run a fixture to completion — through the gate, so the second wave's shots render too.
 * The image backend is whatever the caller hands in, so one driver serves both record and
 * check; `run` is the real scheduler either way.
 */
async function runFixture(
  fixture: FixtureName,
  images: ImageBackend,
  log: (line: string) => void,
): Promise<{ project: TestProject; failed: FailedTask[] }> {
  const failed: FailedTask[] = [];
  // The scheduler logs a failure's message rather than storing it on the task, so collect it
  // here. `ran` counts every terminal task, failures included, and a paid run that generated
  // nothing must not read as a clean one.
  const collector: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, fields) => {
      if (msg !== 'task.end') return;
      failed.push({
        kind: String(fields?.['kind']),
        error: String(fields?.['error'] ?? 'unknown'),
      });
    },
    child: () => collector,
  };
  const tally = (wave: number, summary: { ran: readonly AnyTask[] }, before: number) => {
    const bad = failed.length - before;
    log(
      `  wave ${wave}: ${summary.ran.length - bad} task(s) done` + (bad ? `, ${bad} FAILED` : ''),
    );
  };

  const project = await makeProject({ script: SCRIPTS[fixture] });
  const first = await project.run({ providers: providersFor(project, images), logger: collector });
  tally(1, first, 0);
  if (first.blockedOnGate) {
    const approved = await project.approveAll();
    log(`  gate: approved ${approved.length} character(s)`);
    const before = failed.length;
    const second = await project.run({
      providers: providersFor(project, images),
      logger: collector,
    });
    tally(2, second, before);
  }
  return { project, failed };
}

/** Mock everything except the image backend — see the file header for why. */
function providersFor(p: TestProject, images: ImageBackend) {
  return createMockProviders({
    refLoader: async (ref) => {
      const { store } = await p.current();
      return { bytes: await store.read(ref), ext: ref.ext };
    },
    imageBackend: images,
  });
}

function summarize(
  fixture: FixtureName,
  cache: AssetCache,
  log: readonly ServedRequest[],
  failed: FailedTask[],
): CorpusReport {
  const asked = new Set(log.map((r) => r.key));
  const entries = cache.entries();
  return {
    fixture,
    reused: log.filter((r) => r.hit).length,
    missed: log.filter((r) => !r.hit).length,
    added: log.filter((r) => r.recorded).length,
    orphaned: entries.filter((e) => !asked.has(e.key)),
    missingFiles: [],
    entries: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    failed,
  };
}

/**
 * Record a fixture against the real image model. Costs money, needs a Gemini key, and is meant
 * to be run by a human who decided to spend it, never by a suite.
 */
export async function recordCorpus(opts: CorpusOptions = {}): Promise<CorpusReport> {
  const fixture = opts.fixture ?? 'linear';
  const log = opts.log ?? noop;
  const cache = await AssetCache.open(opts.cacheDir ?? FIXTURE_ASSET_DIR);

  // Built once against a throwaway project purely to resolve the model id and key the same way
  // the CLI does; the project the run uses is created inside `runFixture`.
  const probe = await makeProject({ script: SCRIPTS[fixture] });
  let backend: CachedImageBackend;
  try {
    const config = await loadConfig(probe.dir);
    const keys = await resolveKeys(config, {
      // A test project is a closed world, so the user-level rung is opted out of here rather
      // than inherited. This function spends real money, and it must not succeed on a
      // developer's machine by picking up their own key from an enclosing directory.
      secretsDirs: await secretDirsFor(process.cwd(), { includeUser: false }),
      require: ['gemini'],
    });
    backend = new CachedImageBackend(cache, createGeminiImage(keys.gemini, config.models.image), {
      record: true,
      fixture,
    });
    log(`recording "${fixture}" against ${config.models.image}`);
  } finally {
    await probe.cleanup();
  }

  const { project, failed } = await runFixture(fixture, backend, log);
  await project.cleanup();
  return summarize(fixture, cache, backend.log, failed);
}

/**
 * Audit the corpus without spending anything: replay the fixture against the cache with a
 * placeholder backend behind it, then compare what was asked for against what is held.
 *
 * Reports rather than gates. A stale entry costs a fixture its real art and nothing else, and a
 * suite that failed here would put a paid re-record in the way of an ordinary prompt change.
 */
export async function checkCorpus(opts: CorpusOptions = {}): Promise<CorpusReport> {
  const fixture = opts.fixture ?? 'linear';
  const log = opts.log ?? noop;
  const cache = await AssetCache.open(opts.cacheDir ?? FIXTURE_ASSET_DIR);
  const backend = new CachedImageBackend(cache, new StubImageBackend());

  const { project, failed } = await runFixture(fixture, backend, log);
  await project.cleanup();

  const report = summarize(fixture, cache, backend.log, failed);
  for (const entry of cache.entries()) {
    if (!(await cache.get(entry.key))) report.missingFiles.push(entry);
  }
  return report;
}

/** A human-readable report. Returned rather than printed, so the driver owns the stream. */
export function formatReport(report: CorpusReport): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const lines = [
    `fixture   ${report.fixture}`,
    `reused    ${report.reused}`,
    `missed    ${report.missed}`,
    `added     ${report.added}`,
    `corpus    ${report.entries} entr${report.entries === 1 ? 'y' : 'ies'}, ${mb(report.totalBytes)}`,
  ];
  if (report.failed.length) {
    lines.push(
      `\nFAILED TASKS (${report.failed.length}) — the run recorded less than it was asked to:`,
    );
    for (const f of report.failed) lines.push(`  ${f.kind}: ${f.error}`);
  }
  if (report.missingFiles.length) {
    lines.push(`\nindexed but missing on disk (${report.missingFiles.length}):`);
    for (const e of report.missingFiles)
      lines.push(`  ${e.key}.${e.ext}  ${e.prompt.slice(0, 60)}`);
  }
  if (report.orphaned.length) {
    lines.push(`\nnothing asked for (${report.orphaned.length}):`);
    for (const e of report.orphaned) lines.push(`  ${e.key}.${e.ext}  ${e.prompt.slice(0, 60)}`);
  }
  if (report.missed > 0) {
    // A ref's bytes are in the next request's key, so the first miss re-keys everything after
    // it. Past that point "orphaned" describes the divergence, not a genuinely unused entry.
    lines.push(
      `\nnote: ${report.missed} miss(es) — a ref's bytes are part of the next request's key, so`,
      `everything downstream of the first miss asks a different question than a full corpus`,
      `would. Treat the orphan list as suspect until the corpus is complete.`,
    );
  }
  return lines.join('\n');
}
