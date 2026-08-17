/**
 * Assembling one difficult-agent analysis: the evidence, the redactor, the read tools, and the
 * model that reads all three.
 *
 * It sits beside `commandlog.ts` rather than inside `@vn/agentreport` because every line of it is
 * about *this host* — where a packaged build put its source, which account the app is running as,
 * where fetched documentation may be cached. The package holds what is true of any host.
 */
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
  sourceRoot,
  sourcesFrom,
  type Evidence,
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
  /** Where fetched provider documentation may be cached. Absent means fetch every time. */
  cacheDir?: string;
}

/** `undefined` from `sourceRoot()` is a broken install, and the caller is told so by name. */
export const NO_SOURCE = 'This build did not ship its source, so there is nothing to read.';

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
      ...(req.cacheDir ? { cacheDir: join(req.cacheDir, 'apidocs') } : {}),
      today: new Date().toISOString().slice(0, 10),
    }),
    ctx: { workspace: new Workspace(req.dir), git: openGit(req.dir) },
  };
}

/**
 * Read one conversation and say what went wrong.
 *
 * The redactor is built before the evidence is read and is the only thing that ever hands the
 * transcript to a model, which is what makes the privacy claim in the dialog true rather than
 * aspirational. `machine` is supplied here because the package is pure: the account name and the
 * home directory are facts about this computer, not about the project.
 */
export async function analyseThread(
  req: AnalysisRequest,
): Promise<{ report: Report; evidence: Evidence }> {
  const redactor = buildRedactor(
    sourcesFrom(req.model, {
      projectRoot: req.dir,
      username: userInfo().username,
      homeDir: homedir(),
    }),
  );

  const evidence = await evidenceFor(req.paths, req.threadId, {
    ...(req.appVersion ? { appVersion: req.appVersion } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
  });

  const report = await analyze({
    evidence,
    backend: analystBackend(req.modelId, req.config, req.keys, req.effort),
    redactor,
    ...(req.wanted?.trim() ? { wanted: req.wanted } : {}),
    ...(req.source ? { source: await sourceAccess(req) } : {}),
  });

  return { report, evidence };
}
