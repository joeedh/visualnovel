import { AgentPart } from './agent.js';
import { BackendPart } from './backend.js';
import { ReportPart } from './report.js';
import { GatePart } from './gate.js';
import { AssetPart } from './asset.js';
import { PromptPart } from './prompt.js';
import { ProjectPart } from './project.js';
import { DocsPart } from './docs.js';
import { FilesPart } from './files.js';
import { StoryPart } from './story.js';
import { PipelinePart } from './pipeline.js';
import { GengraphPart } from './gengraph.js';
import { HistoryPart } from './history.js';
import { RecoveryPart } from './recovery.js';
import { SyncPart } from './sync.js';
import { CollectPart } from './collect.js';
import { MissingPart } from './missing.js';
import { GitSurface } from './surface/git.js';

export { loadProject, withShots } from './load/project.js';

/**
 * One workspace's worth of backend state, owned by the Electron main process. This is the
 * desktop app's join point: it embeds BOTH the authoring agent (`@vn/authoring`) and the
 * generative scheduler (`@vn/scheduler`) in-process and exposes them as plain async methods
 * the IPC layer can call. The glue mirrors `apps/authoring/src/agent.ts` (agent assembly)
 * and `apps/cli/src/project.ts` (project + provider construction); it is intentionally not
 * imported from those apps, which aren't libraries.
 *
 * The behavior lives in the `*Part` classes beside this file, one per concern, and the public
 * methods are one-line delegations to them. The delegations are grouped by concern into the
 * abstract `*Surface` classes in `surface/`, which extend one another in a chain starting at
 * `SessionBase` (the session's state and the busy, permission and transcript substrate). This
 * class is the end of that chain: it builds the parts and hands each to the surface that
 * declares it.
 */
export class WorkspaceSession extends GitSurface {
  readonly agentPart: AgentPart = new AgentPart(this);
  readonly backendPart: BackendPart = new BackendPart(this);
  readonly reportPart: ReportPart = new ReportPart(this);
  readonly gatePart: GatePart = new GatePart(this);
  readonly assetPart: AssetPart = new AssetPart(this);
  readonly promptPart: PromptPart = new PromptPart(this);
  readonly projectPart: ProjectPart = new ProjectPart(this);
  readonly docsPart: DocsPart = new DocsPart(this);
  readonly filesPart: FilesPart = new FilesPart(this);
  readonly storyPart: StoryPart = new StoryPart(this);
  readonly pipelinePart: PipelinePart = new PipelinePart(this);
  readonly gengraphPart: GengraphPart = new GengraphPart(this);
  readonly historyPart: HistoryPart = new HistoryPart(this);
  readonly recoveryPart: RecoveryPart = new RecoveryPart(this);
  readonly syncPart: SyncPart = new SyncPart(this);
  readonly collectPart: CollectPart = new CollectPart(this);
  readonly missingPart: MissingPart = new MissingPart(this);
}
