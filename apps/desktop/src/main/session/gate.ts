import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { entityFile, setCharacterApproval, writeApprovedPortrait } from '@vn/store';
import { isApproved } from '@vn/pipeline';
import {
  assetApproved,
  assetPrereqs,
  buildSlotGraph,
  prereqRefusal,
  resolveSlot,
  slotTaskHash,
  type Suspension,
} from '@vn/artgen';
import { chatBackendFor, chatVendorFor, type ChatBackend } from '@vn/providers';
import { TRIAGE_MODEL, type Approvable } from '@vn/authoring';
import type { RefBinding, Shot } from '@vn/types';
import { bindsTo } from '@vn/types';
import type { ApproveResult, AssetFailure, GateCandidate } from '../../shared/ipc.js';
import { reorderApprovals, type ApprovalQueue } from '../approvals.js';
import { labelAssets, labelContext } from '../assetlabel.js';
import type { WorkspaceSession, LoadedProject } from './core.js';
import { suspensionsOf, driftedFrames, readAllShots, loadProject } from './core.js';

export class GatePart {
  constructor(private readonly session: WorkspaceSession) {}

  async gateCandidates(characterId: string): Promise<GateCandidate[]> {
    const project = await loadProject(this.session.dir);
    return project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }))
      .map((a) => ({ hash: a.hash, accepted: a.accepted }));
  }

  /**
   * Whether an approval would land, without performing one: the character, the candidate, and
   * whether it is already approved. A read — `gate.approve` re-decides for itself.
   */
  async gateCandidacy(
    characterId: string,
    hash: string,
  ): Promise<{
    character: boolean;
    candidate: boolean;
    approved: boolean;
    candidates: number;
    suspended?: string;
  }> {
    const project = await loadProject(this.session.dir);
    const character = project.model.characters.get(characterId);
    const candidates = project.store
      .manifest()
      .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }));
    const suspended = await this.suspensionFor(project, hash);
    return {
      character : Boolean(character),
      candidate : candidates.some((a) => a.hash === hash),
      approved  : character ? isApproved(character) : false,
      candidates: candidates.length,
      ...(suspended ? { suspended } : {}),
    };
  }

  /** Flip a character to approved with `hash`: copy the visible portrait, accept the asset. */
  async approveCharacter(characterId: string, hash: string): Promise<ApproveResult> {
    const project = await loadProject(this.session.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    // Approving a suspended picture would bless bytes drawn against a reference that has moved,
    // and everything downstream would inherit it. Repin or regenerate first.
    const suspended = await this.suspensionFor(project, hash);
    if (suspended) return { ok: false, message: `${hash.slice(0, 8)} is suspended: ${suspended}.` };
    const file = entityFile(project.inputs.characterDocs, characterId);
    if (!file || !(await setCharacterApproval(file, hash))) {
      return { ok: false, message: `No character file for "${characterId}".` };
    }
    const bytes = await project.store.read({ hash, ext: 'png' });
    await writeApprovedPortrait(project.paths, characterId, bytes);
    await project.store.accept(hash);
    return { ok: true, message: `Approved ${characterId} → ${hash}.` };
  }

  /**
   * Every picture that could be approved right now, upstream first — the same walk the document
   * tree's “Awaiting approval” group is a projection of, so the agent and the tree can never
   * disagree about what is waiting. A blocked row is still listed, with a sentence saying what
   * it is waiting on: the whole frontier is more useful than just the subset that happens to be
   * actionable this second.
   */
  async approvable(): Promise<Approvable[]> {
    const project = await loadProject(this.session.dir);
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const shots = await readAllShots(project);
    const slots = buildSlotGraph({
      ...labels,
      assets: manifest,
      shots,
      config: project.config,
      graph : project.graph,
    });
    const names = labelAssets(manifest, labels);
    const byHash = new Map(manifest.map((a) => [a.hash, a]));
    const drifted = driftedFrames(project.model, shots);
    const out: Approvable[] = [];
    const seen = new Set<string>();
    for (const key of slots.order) {
      const slot = slots.nodes.get(key);
      if (!slot) continue;
      for (const hash of slot.candidates) {
        const asset = byHash.get(hash);
        // One row per picture, as the tree does it: a sheet bound to two outfits is still one
        // thing to approve, and the first slot that names it is the one it is listed under. A
        // drifted frame is left out: the prose it illustrates has moved since it was drawn, so
        // what it is waiting for is a redraw rather than approval.
        if (!asset || seen.has(hash) || drifted.has(hash) || assetApproved(asset, project.model)) {
          continue;
        }
        seen.add(hash);
        const label = names.get(hash) ?? hash;
        const characterId = asset.satisfies[0]?.characterId;
        // A portrait's refusal comes from the gate, not the accept rule, so only the accept door
        // asks about prerequisites — the same asymmetry `assetInfo` draws.
        const blocked =
          asset.kind === 'portrait'
            ? undefined
            : prereqRefusal(label, assetPrereqs(asset, { ...labels, assets: manifest, shots }));
        out.push({
          hash,
          kind: asset.kind,
          label,
          slot: slot.label,
          door: asset.kind === 'portrait' ? 'gate' : 'accept',
          ...(characterId === undefined ? {} : { characterId }),
          ...(blocked === undefined ? {} : { blocked }),
          // The slot's own asymmetric answer (gate for a portrait, `accepted` for everything
          // else), carried through so a caller approving in bulk can tell "nothing has settled
          // this yet" from "this is the take that lost".
          ...(slot.approved ? { settled: true } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Every picture that is approved right now, downstream first — the reverse of {@link approvable}
   * in both the filter and the order, because taking approval back has to run the other way: a
   * frame stops being accepted before the plate it was drawn from does.
   */
  async approvedAssets(): Promise<Approvable[]> {
    const project = await loadProject(this.session.dir);
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const shots = await readAllShots(project);
    const slots = buildSlotGraph({
      ...labels,
      assets: manifest,
      shots,
      config: project.config,
      graph : project.graph,
    });
    const names = labelAssets(manifest, labels);
    const byHash = new Map(manifest.map((a) => [a.hash, a]));
    const out: Approvable[] = [];
    const seen = new Set<string>();
    for (const key of [...slots.order].reverse()) {
      const slot = slots.nodes.get(key);
      if (!slot) continue;
      for (const hash of slot.candidates) {
        const asset = byHash.get(hash);
        if (!asset || seen.has(hash) || !assetApproved(asset, project.model)) continue;
        seen.add(hash);
        const characterId = asset.satisfies[0]?.characterId;
        out.push({
          hash,
          kind : asset.kind,
          label: names.get(hash) ?? hash,
          slot : slot.label,
          door : asset.kind === 'portrait' ? 'gate' : 'accept',
          ...(characterId === undefined ? {} : { characterId }),
        });
      }
    }
    return out;
  }

  /**
   * The same list, ordered for reading rather than for approving: whatever `previousOrder` has
   * not seen goes on top. The caller owns `previousOrder` because it outlives the session — it is
   * persisted per project, so the list survives a restart.
   */
  async approvalQueue(previousOrder: readonly string[]): Promise<ApprovalQueue> {
    return reorderApprovals(await this.session.approvable(), previousOrder);
  }

  /** Approve one `Approvable` through whichever door it belongs to. */
  async approveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    if (item.door !== 'gate') return this.session.acceptAsset(item.hash);
    if (!item.characterId) {
      return {
        ok     : false,
        message: `${item.label} is a portrait of nobody — nothing to clear.`,
      };
    }
    return this.session.approveCharacter(item.characterId, item.hash);
  }

  /** Take approval back off one `Approvable`, through whichever door approved it. */
  async unapproveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    const result = await this.session.unapproveAsset(item.hash);
    return { ok: result.ok, message: result.message };
  }

  /**
   * The small model that reads the author's own words before art is approved on their say-so.
   * Fixed at {@link TRIAGE_MODEL} rather than following the conversation's model: this is a check
   * on the agent, and running it on the model being checked would not be a check. Returns
   * `null` in a mocked session, where `@vn/authoring`'s `offlineTriage` stands in and says so.
   */
  async triageBackend(): Promise<ChatBackend | null> {
    if (this.session.mock) return null;
    const config = await loadConfig(this.session.dir);
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(this.session.dir),
      require    : [chatVendorFor(TRIAGE_MODEL)],
    });
    return chatBackendFor(TRIAGE_MODEL, keys).backend;
  }

  /**
   * Every suspended asset, upstream first, with the reason for each. Derived on every call:
   * suspension is a walk over the manifest and the rungs, never a stored flag
   * (`docs/plans/archive/INDEX.md#chunked-prompts` §13).
   */
  async suspensions(): Promise<Suspension[]> {
    const project = await loadProject(this.session.dir);
    const shots = await readAllShots(project);
    return [...suspensionsOf(project, shots).values()];
  }

  /** Why one asset is suspended, against a project already loaded. `undefined` when it is not. */
  private async suspensionFor(project: LoadedProject, hash: string): Promise<string | undefined> {
    return suspensionsOf(project, await readAllShots(project)).get(hash)?.reason;
  }

  /**
   * The task the project would run for a slot today, or `undefined` when the slot no longer
   * resolves. One slot is resolved rather than the whole graph, which is what keeps this cheap
   * enough for every read of the asset pane.
   */
  slotTask(
    project: LoadedProject,
    binding: RefBinding,
    shots: ReadonlyMap<string, Shot[] | null>,
  ): string | undefined {
    const decided = resolveSlot(binding, {
      model: project.model,
      shots,
      config: project.config,
      graph : project.graph,
    });
    return decided.ok ? slotTaskHash(decided.plan) : undefined;
  }

  /**
   * Why the picture an asset fills is not finished, or `undefined` while it is still on its way.
   *
   * Two tasks are asked, in order. The slot's identity as the project states it today comes first,
   * because an art-notes edit gives the slot a new one and a run that fails on it leaves the last
   * good render on screen with nothing saying the re-render did not happen. The task these bytes
   * came from answers second, for the frame that was drawn and then flagged.
   */
  failureOf(
    project: LoadedProject,
    current: string | undefined,
    sourceTask: string,
  ): AssetFailure | undefined {
    for (const hash of [current, sourceTask]) {
      if (!hash) continue;
      const task = project.graph.get(hash);
      if (!task || (task.status !== 'failed' && task.status !== 'needs_human')) continue;
      return {
        task  : hash,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
        attempts   : task.attempts.filter((a) => a.error).length,
        maxAttempts: project.config.max_task_attempts,
        later      : hash !== sourceTask,
      };
    }
    return undefined;
  }

  /**
   * Every asset in the manifest, named the way the document tree names them. One label pass over
   * the whole manifest rather than the per-asset resolution `assetInfo` does, because the caller
   * is a picker showing all of them at once.
   */
}
