/**
 * Assembling one difficult-agent analysis: the evidence, the redactor, the read tools, and the
 * model that reads all three.
 *
 * It sits beside `commandlog.ts` rather than inside `@vn/agentreport` because every line of it is
 * about *this host* — where a packaged build put its source, which account the app is running as,
 * where fetched documentation may be cached. The package holds what is true of any host.
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
  createSourceTools,
  redactEvidence,
  sourceRoot,
  sourcesFrom,
  type Evidence,
  type Redactor,
  type Report,
  type SourceAccess,
} from '@vn/agentreport';
import { evidenceFor } from './commandlog.js';

export interface AnalysisRequest {
  dir: string;
  paths: ProjectPaths;
  config: ProjectConfig;
  /** The loaded project, which is where every fictional name the redactor knows comes from. */
  model: ProjectModel;
  keys: ResolvedKeys;
  threadId: string;
  /** The model doing the reading, already resolved from the dialog or the bound one. */
  modelId: string;
  effort?: EffortChoice;
  /** What the author said they had wanted. Redacted like everything else. */
  wanted?: string;
  /** Whether the author let the analyst read the source. */
  source: boolean;
  appVersion?: string;
  /**
   * The app's own directory — where the drafted report is kept and where fetched provider
   * documentation is cached. Absent in tests: nothing is written and every fetch goes out fresh.
   */
  userData?: string;
}

/** `undefined` from `sourceRoot()` is a broken install, and the caller is told so by name. */
export const NO_SOURCE = 'This build did not ship its source, so there is nothing to read.';

/**
 * Keep a copy of the report beside the app's own files, never inside the project.
 *
 * `vngen/` is committed on purpose, and a redacted transcript of someone's conversation with an
 * agent is not something to commit on their behalf — a bug report is about the *app*, not about
 * the story. Writing here is also why `report.agent` can stay `mutating: false`: nothing under the
 * worktree moves, so commit-on-save is not involved at all.
 *
 * A failed write is swallowed by the caller: the report is in hand either way, and losing the
 * archive copy is not a reason to lose the analysis that was just paid for.
 */
export async function saveReport(userData: string, body: string, at: Date): Promise<string> {
  const dir = join(userData, 'reports');
  await mkdir(dir, { recursive: true });
  // Colons are not filenames on Windows, and the dots read as extensions everywhere.
  const stamp = at
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d+Z$/, '');
  const file = join(dir, `${stamp}.md`);
  await writeFile(file, body, 'utf8');
  return file;
}

/**
 * The redactor for one loaded project: every name the fiction uses, plus the three things this
 * computer gives away. `machine` is filled in here because the package is pure — the account name
 * and the home directory are facts about the host, not about the project.
 *
 * One redactor is one pseudonym table, so the caller keeps the one an analysis was written with:
 * scanning a finished report with a *different* redactor would be scanning for different names.
 */
export function makeRedactor(dir: string, model: ProjectModel): Redactor {
  return buildRedactor(
    sourcesFrom(model, { projectRoot: dir, username: userInfo().username, homeDir: homedir() }),
  );
}

/**
 * The read tools, in a context holding the two things `@vn/authoring`'s loop insists on. Nothing
 * in the registry touches either — the tools resolve their own roots — but the loop's type says
 * a context has a workspace and a git, and satisfying it honestly costs nothing.
 */
async function sourceAccess(req: AnalysisRequest): Promise<SourceAccess> {
  const root = await sourceRoot();
  if (!root) throw new Error(NO_SOURCE);
  return {
    registry: createSourceTools({
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
 * The redactor is built before the evidence is read, and **the evidence is put through it here** —
 * so what comes back is already clean, and the model, the rendered issue and the copy saved to
 * disk are all reading the same redacted value. That is what makes the privacy claim in the dialog
 * true rather than aspirational: nothing downstream has to remember to redact, because there is
 * nothing left to redact. It is handed back so the leak scan over the finished report runs against
 * the same table this was written with.
 */
export async function analyseThread(
  req: AnalysisRequest,
): Promise<{ report: Report; evidence: Evidence; redactor: Redactor }> {
  const redactor = makeRedactor(req.dir, req.model);

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
    ...(req.source ? { source: await sourceAccess(req) } : {}),
  });

  return { report, evidence, redactor };
}
