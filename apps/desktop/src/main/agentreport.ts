/**
 * Assembles one difficult-agent analysis from the evidence, the redactor, the read tools, and the
 * model that reads all three.
 *
 * This lives beside `commandlog.ts` rather than inside `@vn/agentreport` because it is all about
 * the desktop host: where a packaged build put its source, which account the app runs as, and
 * where fetched documentation is cached. The package holds what is true of any host.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@vn/authoring';
import { openGit } from '@vn/git';
import { appendJsonl, readJsonl } from '@vn/util';
import type { ProjectConfig, ProjectModel, EffortChoice } from '@vn/types';
import type { ProjectPaths } from '@vn/store';
import { userConfigDir, type ResolvedKeys } from '@vn/config';
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
  type AnalystGrant,
  type AnalystOptions,
  type Evidence,
  type Redactor,
  type Report,
  type SourceAccess,
  type ToolSummary,
} from '@vn/agentreport';
import { captureSnapshot, type CaptureSnapshot } from '@vn/providers';
import { asked, emptyConvo, received, type FeedItem } from '../shared/convo.js';
import type { ReportRow } from '../shared/ipc.js';
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
  /** The author's stated intent, redacted like every other field here. */
  wanted?: string;
  /**
   * The tools the agent under report could call, so a recommendation is written against what that
   * agent can reach.
   */
  reportedTools?: readonly ToolSummary[];
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

/** The version every transcript line carries. Bumped when a line's fields change meaning. */
export const TRANSCRIPT_VERSION = 1;

/** How many debug transcripts are kept. The oldest goes when the eleventh conversation starts. */
export const TRANSCRIPTS_KEPT = 10;

const TRANSCRIPT_SUFFIX = '.jsonl';

/**
 * One line of a debug transcript.
 *
 * `opened` and `granted` are not rows of the conversation: they are the setup card as it collapsed
 * and each access the author handed over part way through. They carry no content of their own, and
 * they are what explains the tool names that follow.
 */
export type TranscriptBody =
  | {
      kind: 'opened';
      thread: string;
      model: string;
      effort?: string;
      source: boolean;
      detail: boolean;
    }
  | { kind: 'granted'; access: 'source' | 'detail' }
  | { kind: FeedItem['role']; text: string }
  | { kind: 'filed'; title: string; body: string };

export type TranscriptLine = TranscriptBody & { v: number; at: string };

/** Where debug transcripts live: user-level state, outside every repository. */
export function transcriptsDir(): string {
  return join(userConfigDir(), 'debug-transcripts');
}

/**
 * What one row of the conversation is written down as, or nothing where the row is about the
 * machinery rather than about what was said — a token count, or a retry.
 *
 * The line comes from the same reducer the pane draws with, so the file and the screen cannot word
 * a turn differently. `FeedItem.detail` is dropped here and nowhere else: it carries what a tool
 * returned, and the request captures in particular are the author's own traffic, read on the
 * author's own key. A file that is easy to attach to an issue must not carry them.
 */
export function transcriptBody(row: ReportRow): TranscriptBody | undefined {
  // The archived copy's path is left out with it: that path is under the author's home directory,
  // and nothing outside the evidence has been through the redactor
  if (row.kind === 'filed') return { kind: 'filed', title: row.title, body: row.body };
  const convo =
    row.kind === 'said' ? asked(emptyConvo(''), row.text) : received(emptyConvo(''), row.event);
  const item = convo.feed[0];
  return item ? { kind: item.role, text: item.text } : undefined;
}

/**
 * One debug conversation on disk, appended a line at a time.
 *
 * Writes are queued rather than awaited by the caller, because the events of a turn arrive from a
 * synchronous push and a transcript that cannot be written must not take down the conversation it
 * is recording. A failed append is dropped and the next line still tries.
 */
export class Transcript {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  write(body: TranscriptBody, at = new Date()): void {
    const line = { v: TRANSCRIPT_VERSION, at: at.toISOString(), ...body };
    this.queue = this.queue.then(() => appendJsonl(this.file, line)).catch(() => {});
  }

  /** One row of the conversation, where it is one that gets written down. */
  row(row: ReportRow): void {
    const body = transcriptBody(row);
    if (body) this.write(body);
  }

  /** Resolves once every queued line has landed, which is what a test waits on. */
  settled(): Promise<void> {
    return this.queue;
  }
}

/**
 * Start a transcript, pruning the directory to {@link TRANSCRIPTS_KEPT} counting the new one.
 * Pruning happens as a conversation starts rather than as one ends, so a run that crashed cannot
 * leave an eleventh behind.
 *
 * The name is an ISO stamp with the characters Windows forbids replaced, so name order is time
 * order and the prune is a sort.
 */
export async function openTranscript(at = new Date()): Promise<Transcript> {
  const dir = transcriptsDir();
  await mkdir(dir, { recursive: true });
  const kept = (await readdir(dir)).filter((name) => name.endsWith(TRANSCRIPT_SUFFIX)).sort();
  for (const name of kept.slice(0, Math.max(0, kept.length - (TRANSCRIPTS_KEPT - 1)))) {
    await rm(join(dir, name), { force: true });
  }
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return new Transcript(join(dir, `${stamp}${TRANSCRIPT_SUFFIX}`));
}

/**
 * Read a transcript back, skipping any line whose version this build does not know. The version is
 * per line rather than per file so that one unreadable line still leaves the rest readable.
 */
export async function readTranscript(file: string): Promise<TranscriptLine[]> {
  const lines = await readJsonl<TranscriptLine>(file);
  return lines.filter((line) => line.v === TRANSCRIPT_VERSION);
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
      sourceRoot : root,
      projectRoot: req.dir,
      ...(req.userData ? { cacheDir: join(req.userData, 'apidocs') } : {}),
      today: new Date().toISOString().slice(0, 10),
    }),
    ctx     : { workspace: new Workspace(req.dir), git: openGit(req.dir) },
  };
}

/** Everything one analysis is built from, whether it runs headless or as a conversation. */
export interface AnalysisParts {
  /** Ready to hand to `analyze` or, with a host added, to `createAnalyst`. */
  options: AnalystOptions;
  evidence: Evidence;
  redactor: Redactor;
  /** The frozen capture ring, kept so a later grant reads what was there when the analysis began. */
  snapshot: CaptureSnapshot;
  /** One budget across every kind of reading the analysis does, grants included. */
  budget: Budget;
}

/**
 * Assemble one analysis: the redactor, the redacted evidence, the backend and whichever read tools
 * the author allowed.
 *
 * The redactor is built before the evidence is read, and the evidence is redacted here, so the
 * model, the rendered issue and the copy saved to disk all read the same redacted value. Nothing
 * downstream has to remember to redact. The redactor is returned so the leak scan over the finished
 * report runs against the same pseudonym table the report was written with.
 */
export async function analysisParts(req: AnalysisRequest): Promise<AnalysisParts> {
  const redactor = makeRedactor(req.dir, req.model);
  // Frozen before anything is read, and before the analyst's own turns could add to the ring
  const snapshot = captureSnapshot();
  const budget = new Budget();

  const evidence = redactEvidence(
    await evidenceFor(req.paths, req.threadId, {
      ...(req.appVersion ? { appVersion: req.appVersion } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    }),
    redactor,
  );

  return {
    evidence,
    redactor,
    snapshot,
    budget,
    options: {
      evidence,
      backend: analystBackend(req.modelId, req.config, req.keys, req.effort),
      redactor,
      ...(req.wanted?.trim() ? { wanted: req.wanted } : {}),
      ...(req.reportedTools?.length ? { reportedTools: req.reportedTools } : {}),
      ...(req.source ? { source: await sourceAccess(req, budget) } : {}),
      ...(req.detail ? { detail: createRequestTools({ snapshot, redactor, budget }) } : {}),
      // A detail-only run has no source root to take a context from, so it supplies its own. The
      // request tools use neither the workspace nor the git; only the loop's type asks for them.
      ctx: { workspace: new Workspace(req.dir), git: openGit(req.dir) },
    },
  };
}

/** The source tools, as a grant a live analyst can be given part way through. */
export async function sourceGrant(req: AnalysisRequest, budget: Budget): Promise<AnalystGrant> {
  const access = await sourceAccess(req, budget);
  return { kind: 'source', tools: access.registry };
}

/** The request-capture tools, as a grant a live analyst can be given part way through. */
export function detailGrant(parts: AnalysisParts): AnalystGrant {
  const { snapshot, redactor, budget } = parts;
  return { kind: 'detail', tools: createRequestTools({ snapshot, redactor, budget }) };
}

/**
 * Read one conversation and say what went wrong, in one call and without anyone watching. This is
 * what `report.agent` runs.
 */
export async function analyseThread(
  req: AnalysisRequest,
): Promise<{ report: Report; evidence: Evidence; redactor: Redactor }> {
  const { options, evidence, redactor } = await analysisParts(req);
  return { report: await analyze(options), evidence, redactor };
}
