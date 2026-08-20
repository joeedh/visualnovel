/**
 * Assembles one difficult-agent analysis from the evidence, the redactor, the read tools, and the
 * model that reads all three.
 *
 * This lives beside `commandlog.ts` rather than inside `@vn/agentreport` because it is all about
 * the desktop host: where a packaged build put its source, which account the app runs as, and
 * where fetched documentation is cached. The package holds what is true of any host.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@vn/authoring';
import { openGit } from '@vn/git';
import type { ProjectConfig, ProjectModel, EffortChoice } from '@vn/types';
import type { ProjectPaths } from '@vn/store';
import type { ResolvedKeys } from '@vn/config';
import {
  analystBackend,
  analyze,
  buildRedactor,
  createRequestTools,
  createSourceTools,
  redactEvidence,
  sourceRoot,
  sourcesFrom,
  Budget,
  type Evidence,
  type Redactor,
  type Report,
  type SourceAccess,
} from '@vn/agentreport';
import { captureSnapshot } from '@vn/providers';
import { evidenceFor } from './commandlog.js';

export interface AnalysisRequest {
  dir: string;
  paths: ProjectPaths;
  config: ProjectConfig;
  /** The loaded project, which is where every fictional name the redactor knows comes from. */
  model: ProjectModel;
  keys: ResolvedKeys;
  threadId: string;
  /** The model doing the reading, already resolved from the dialog or from the bound model. */
  modelId: string;
  effort?: EffortChoice;
  /** What the author said they had wanted. Redacted like everything else. */
  wanted?: string;
  /** Whether the author let the analyst read the source. */
  source: boolean;
  /**
   * Whether the author let the analyst read the requests the app sent, which are the bodies a
   * positional API error indexes into. Independent of {@link source}, and either alone is a valid
   * analysis.
   *
   * Nothing read this way reaches the report. The requests are the author's own conversation, read
   * on the author's own key, which keeps the privacy area to their model provider.
   */
  detail?: boolean;
  appVersion?: string;
  /**
   * The app's own directory — where the drafted report is kept and where fetched provider
   * documentation is cached. Absent in tests, where nothing is written and every fetch goes out
   * fresh.
   */
  userData?: string;
}

/** Reported when `sourceRoot()` returns `undefined`, which means a broken install. */
export const NO_SOURCE = 'This build did not ship its source, so there is nothing to read.';

/**
 * Keeps a copy of the report beside the app's own files, never inside the project.
 *
 * `vngen/` is committed on purpose, and a redacted transcript of someone's conversation with an
 * agent should not be committed on their behalf. Writing outside the worktree is also why
 * `report.agent` can stay `mutating: false`, since commit-on-save is never involved.
 *
 * The caller swallows a failed write, because the report is in hand either way and losing the
 * archive copy should not lose the analysis that was just paid for.
 */
export async function saveReport(userData: string, body: string, at: Date): Promise<string> {
  const dir = join(userData, 'reports');
  await mkdir(dir, { recursive: true });
  // Colons are illegal in Windows filenames, and the fractional-second dots read as extensions
  const stamp = at
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d+Z$/, '');
  const file = join(dir, `${stamp}.md`);
  await writeFile(file, body, 'utf8');
  return file;
}

/**
 * Builds the redactor for one loaded project, covering every name the fiction uses plus the
 * identifying details of this computer. `machine` is filled in here because the package is pure:
 * the account name and the home directory are facts about the host, not about the project.
 *
 * Each redactor carries its own pseudonym table, so the caller keeps the one an analysis was
 * written with. Scanning a finished report with another redactor would scan for different names.
 */
export function makeRedactor(dir: string, model: ProjectModel): Redactor {
  return buildRedactor(
    sourcesFrom(model, { projectRoot: dir, username: userInfo().username, homeDir: homedir() }),
  );
}

/**
 * The read tools, in a context holding the workspace and git that `@vn/authoring`'s loop type
 * requires. Nothing in the registry uses either, because the tools resolve their own roots.
 */
async function sourceAccess(req: AnalysisRequest, budget: Budget): Promise<SourceAccess> {
  const root = await sourceRoot();
  if (!root) throw new Error(NO_SOURCE);
  return {
    registry: createSourceTools({
      budget,
      sourceRoot: root,
      projectRoot: req.dir,
      ...(req.userData ? { cacheDir: join(req.userData, 'apidocs') } : {}),
      today: new Date().toISOString().slice(0, 10),
    }),
    ctx: { workspace: new Workspace(req.dir), git: openGit(req.dir) },
  };
}

/**
 * Read one conversation and say what went wrong.
 *
 * The redactor is built before the evidence is read, and the evidence is redacted here, so the
 * model, the rendered issue and the copy saved to disk all read the same redacted value. Nothing
 * downstream has to remember to redact. The redactor is returned so the leak scan over the
 * finished report runs against the same pseudonym table the report was written with.
 */
export async function analyseThread(
  req: AnalysisRequest,
): Promise<{ report: Report; evidence: Evidence; redactor: Redactor }> {
  const redactor = makeRedactor(req.dir, req.model);
  // Frozen before anything is read, and before the analyst's own turns could add to the ring
  const snapshot = captureSnapshot();
  // One budget covers the whole analysis, across every kind of reading it does
  const budget = new Budget();

  const evidence = redactEvidence(
    await evidenceFor(req.paths, req.threadId, {
      ...(req.appVersion ? { appVersion: req.appVersion } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    }),
    redactor,
  );

  const report = await analyze({
    evidence,
    backend: analystBackend(req.modelId, req.config, req.keys, req.effort),
    redactor,
    ...(req.wanted?.trim() ? { wanted: req.wanted } : {}),
    ...(req.source ? { source: await sourceAccess(req, budget) } : {}),
    ...(req.detail ? { detail: createRequestTools({ snapshot, redactor, budget }) } : {}),
    // A detail-only run has no source root to take a context from, so it supplies its own. The
    // request tools use neither the workspace nor the git; only the loop's type asks for them.
    ctx: { workspace: new Workspace(req.dir), git: openGit(req.dir) },
  });

  return { report, evidence, redactor };
}
