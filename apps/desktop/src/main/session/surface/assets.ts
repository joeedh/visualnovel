import type { AdoptVia } from '@vn/artgen';
import type { Suspension } from '@vn/constraint-solver';
import type { Approvable } from '@vn/authoring';
import type { ApproveResult, AssetInfo, AssetListing, GateCandidate } from '../../../shared/ipc.js';
import type { ApprovalQueue } from '../../workspace/approvals.js';
import type { PromptView } from '../../../shared/prompt.js';
import type { GatePart } from '../gate.js';
import type { AssetPart } from '../asset.js';
import type { PromptPart } from '../prompt.js';
import type { ChunkOp, ClearPart, PromptResult, PromptWriteResult } from '../types/results.js';
import { AgentSurface } from './agent.js';
export abstract class AssetsSurface extends AgentSurface {
  abstract readonly gatePart: GatePart;
  abstract readonly assetPart: AssetPart;
  abstract readonly promptPart: PromptPart;

  async gateCandidates(characterId: string): Promise<GateCandidate[]> {
    return this.gatePart.gateCandidates(characterId);
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
    return this.gatePart.gateCandidacy(characterId, hash);
  }

  async approveCharacter(characterId: string, hash: string): Promise<ApproveResult> {
    return this.gatePart.approveCharacter(characterId, hash);
  }

  async gateLockState(
    characterId: string,
  ): Promise<{ character: boolean; locked: boolean; mirror?: string }> {
    return this.gatePart.gateLockState(characterId);
  }

  async lockCharacter(
    characterId: string,
    locked: boolean,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.gatePart.lockCharacter(characterId, locked);
  }

  /**
   * Every picture that could be approved right now, upstream first — the same walk the document
   * tree's “Awaiting approval” group is a projection of, so the agent and the tree can never
   * disagree about what is waiting. A blocked row is still listed, with a sentence saying what
   * it is waiting on: the whole frontier is more useful than just the subset that happens to be
   * actionable this second.
   */
  async approvable(): Promise<Approvable[]> {
    return this.gatePart.approvable();
  }

  /**
   * Every picture that is approved right now, downstream first — the reverse of {@link approvable}
   * in both the filter and the order, because taking approval back has to run the other way: a
   * frame stops being accepted before the plate it was drawn from does.
   */
  async approvedAssets(): Promise<Approvable[]> {
    return this.gatePart.approvedAssets();
  }

  /**
   * The same list, ordered for reading rather than for approving: whatever `previousOrder` has
   * not seen goes on top. The caller owns `previousOrder` because it outlives the session — it is
   * persisted per project, so the list survives a restart.
   */
  async approvalQueue(previousOrder: readonly string[]): Promise<ApprovalQueue> {
    return this.gatePart.approvalQueue(previousOrder);
  }

  async approveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    return this.gatePart.approveOne(item);
  }

  async unapproveOne(item: Approvable): Promise<{ ok: boolean; message: string }> {
    return this.gatePart.unapproveOne(item);
  }

  /**
   * Every suspended asset, upstream first, with the reason for each. Derived on every call:
   * suspension is a walk over the manifest and the rungs, never a stored flag
   * (`docs/plans/archive/INDEX.md#chunked-prompts` §13).
   */
  async suspensions(): Promise<Suspension[]> {
    return this.gatePart.suspensions();
  }

  /**
   * Every asset in the manifest, named the way the document tree names them. One label pass over
   * the whole manifest rather than the per-asset resolution `assetInfo` does, because the caller
   * is a picker showing all of them at once.
   */
  async assetLibrary(): Promise<AssetListing[]> {
    return this.assetPart.assetLibrary();
  }

  /**
   * Everything the asset editor draws for one asset: what the bytes are, the prompt they were
   * made from, the prompt the builders would write now, and the art-notes rungs that reach it.
   * `null` when the manifest has never heard of the hash.
   */
  async assetInfo(hash: string): Promise<AssetInfo | null> {
    return this.assetPart.assetInfo(hash);
  }

  /**
   * Whether accepting this asset is a question worth answering. Three kinds are refused by name:
   * a portrait, because approving one also writes `character.md` and `approved.png` and that is
   * `gate.approve`; a concept, because nothing downstream consumes one, so `accepted` would
   * mean nothing; and a reference, because nothing generated it — it counts by being pointed at.
   * Already accepted is not a refusal — re-accepting is how an author changes their mind.
   */
  async previewAccept(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewAccept(hash);
  }

  /**
   * Mark an asset as the accepted one for what it satisfies. Generic across both roots, and it
   * asks {@link previewAccept} itself rather than trusting that a check already ran — a caller
   * may skip the check, so the command cannot rely on it having happened.
   *
   * Accepting is exclusive per slot: the takes this one replaces are un-accepted in the same write,
   * because a slot with two accepted candidates cannot be resolved and reads as empty.
   */
  async acceptAsset(hash: string): Promise<PromptWriteResult> {
    return this.assetPart.acceptAsset(hash);
  }

  /**
   * Answers whether taking approval back off this asset is worth doing. A concept and a reference
   * are refused by name, for the reason {@link previewAccept} refuses them, since neither is ever
   * approved and there is nothing to take back. An asset that is not the accepted one is refused
   * too, since un-approving is about the answer a slot has rather than about a losing take.
   *
   * A portrait goes through the P3 gate, so its sentence says what else comes back out with it.
   */
  async previewUnapprove(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewUnapprove(hash);
  }

  /**
   * Take approval back off an asset: the manifest flag for an ordinary one, and for a portrait
   * the whole P3 gate — the sheet's `status:` and `approved_portrait:`, and `approved.png`.
   *
   * Asks {@link previewUnapprove} itself for the reason {@link acceptAsset} asks its own preview:
   * a caller may skip the check, so the write cannot rely on one having run.
   *
   * The bytes are never touched. Everything drawn from what this un-approves keeps its own
   * approval, and the slot graph reports it as blocked again until something answers the slot.
   */
  async unapproveAsset(hash: string): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.unapproveAsset(hash);
  }

  async previewRegenerate(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRegenerate(hash);
  }

  /**
   * Put an asset's task back to `pending` so the next run re-renders it. Appending a `pending`
   * snapshot to `tasks.jsonl` performs the requeue — `loadGraph` replays last-writer-wins, which
   * is how `requeueFailed` already works — so this needs no new scheduler machinery.
   *
   * A slot a generation graph draws needs a second step. The graph's own journal resumes every
   * node whose hash still matches, so requeuing the task alone would replay the same picture out
   * of the journal; the paid nodes upstream of that graph's output are invalidated as well.
   */
  async regenerateAsset(
    hash: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
    return this.assetPart.regenerateAsset(hash);
  }

  /** What `pipeline.draw` would do, without doing it. */
  async previewDraw(slot: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewDraw(slot);
  }

  /** Requeue one slot's task where it has run, and answer the task hash a targeted run takes. */
  async drawSlot(
    slot: string,
  ): Promise<{ ok: boolean; message: string; written: string[]; task?: string }> {
    return this.assetPart.drawSlot(slot);
  }

  async previewArtNotes(target: string, notes: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtNotes(target, notes);
  }

  /**
   * Write one art-notes rung, through the rule `vnauthor`'s `set_art_notes` runs — an entity rung
   * into the sheet the model was built from, a shot rung into `work/shots/<sceneId>.json`.
   */
  async setArtNotes(
    target: string,
    notes: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtNotes(target, notes);
  }

  async previewArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtSeed(target, seed);
  }

  async setArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtSeed(target, seed);
  }

  async previewArtModel(target: string, model: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewArtModel(target, model);
  }

  async setArtModel(
    target: string,
    model: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.setArtModel(target, model);
  }

  /**
   * The composed prompt for one asset: the chunks the builders derived, what the author's override
   * does to them, and the one string that would be sent. `null` when the manifest has never heard
   * of the hash.
   *
   * The pane reads this off `assetInfo`, so a picture and its prompt are one round trip; the
   * command is the same projection for an agent and for CDP.
   */
  async promptView(hash: string): Promise<PromptView | null> {
    return this.promptPart.promptView(hash);
  }

  previewPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptResult> {
    return this.promptPart.previewPromptChunk(hash, chunk, op, text);
  }

  setPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptWriteResult> {
    return this.promptPart.setPromptChunk(hash, chunk, op, text);
  }

  previewMoveChunk(hash: string, chunk: string, after: string): Promise<PromptResult> {
    return this.promptPart.previewMoveChunk(hash, chunk, after);
  }

  movePromptChunk(hash: string, chunk: string, after: string): Promise<PromptWriteResult> {
    return this.promptPart.movePromptChunk(hash, chunk, after);
  }

  previewCustomPrompt(hash: string, text: string): Promise<PromptResult> {
    return this.promptPart.previewCustomPrompt(hash, text);
  }

  setCustomPrompt(hash: string, text: string): Promise<PromptWriteResult> {
    return this.promptPart.setCustomPrompt(hash, text);
  }

  previewClearPrompt(hash: string, part: ClearPart): Promise<PromptResult> {
    return this.promptPart.previewClearPrompt(hash, part);
  }

  clearPrompt(hash: string, part: ClearPart): Promise<PromptWriteResult> {
    return this.promptPart.clearPrompt(hash, part);
  }

  async previewAddRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.promptPart.previewAddRef(hash, chunk, ref);
  }

  async addPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.promptPart.addPromptRef(hash, chunk, ref);
  }

  previewDropRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.promptPart.previewDropRef(hash, chunk, ref);
  }

  dropPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.promptPart.dropPromptRef(hash, chunk, ref);
  }

  async previewRepin(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptResult> {
    return this.promptPart.previewRepin(hash, chunk, ref, regenerate);
  }

  /**
   * Move a pinned reference to what its slot holds now. The adoption is decided first, then the
   * pin is written, then the adoption is logged — so a refusal leaves the pin where it was rather
   * than leaving a moved pin with no output.
   */
  async repinPrompt(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptWriteResult> {
    return this.promptPart.repinPrompt(hash, chunk, ref, regenerate);
  }

  /**
   * What `prompt.condense` would spend the call on. It cannot know what the model will write, so
   * this answers the two questions that do not need it: is there anything to condense, and is
   * there a hand-written prompt in the way.
   */
  async previewCondense(hash: string, force: boolean): Promise<PromptResult> {
    return this.promptPart.previewCondense(hash, force);
  }

  /**
   * Condense the chunks into one prompt and store it at the rung. The condensation is held the
   * moment the chunks move under it — `composePrompt` keeps sending this text rather than the
   * fresh chunks, because re-rendering would move the task hash and re-render the picture.
   */
  async condenseAssetPrompt(hash: string, force: boolean): Promise<PromptWriteResult> {
    return this.promptPart.condenseAssetPrompt(hash, force);
  }

  /**
   * Which chunks the effective prompt still appears to say — `prompt.check`, and the same answer
   * the pane's marks come from. A read, so it never refuses over mode: in chunks mode nothing can
   * be missing, which is itself worth being able to ask.
   */
  async checkPrompt(hash: string): Promise<PromptResult> {
    return this.promptPart.checkPrompt(hash);
  }

  async previewConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewConcept(sentence, subject);
  }

  /**
   * Draw one concept image: a sentence in, an asset out, with no task node and no place in any
   * plan — the one path to an image the planner deliberately does not have. Providers come from
   * the session's own `mock` flag, so there is no second policy about whether this run makes
   * real art.
   */
  async drawConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    return this.assetPart.drawConcept(sentence, subject);
  }

  async previewUpload(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewUpload(file, title, slot, replace);
  }

  /**
   * Bring an outside image into the base asset store. With no slot it is a `reference`: nothing
   * generated it, so it is never accepted and never planned — it exists only to be pointed at by a
   * prompt chunk. With a slot it is filed the same way and then adopted as that slot's output.
   */
  async uploadAsset(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    return this.assetPart.uploadAsset(file, title, slot, replace);
  }

  async previewAdopt(
    hash: string,
    slot: string,
    replace: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewAdopt(hash, slot, replace);
  }

  /**
   * Record bytes already in the store as a slot's output — the general form of promotion. The task
   * identity is derived from the project as it stands and logged `done`, so the next run adopts the
   * picture rather than rendering over it.
   */
  async adoptAsset(
    hash: string,
    slot: string,
    replace: boolean,
    via?: AdoptVia,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    return this.assetPart.adoptAsset(hash, slot, replace, via);
  }

  /**
   * Copy one asset's bytes to a path the author chose. Nothing about the project changes — this is
   * the picture leaving, not the project being edited — so no manifest is touched and no
   * provenance is written, and the path is deliberately not narrowed to the workspace.
   */
  async exportAsset(
    hash: string,
    file: string,
  ): Promise<{ ok: boolean; message: string; file?: string }> {
    return this.assetPart.exportAsset(hash, file);
  }

  async previewRestore(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRestore(hash);
  }

  /**
   * Put an older take back in its slot and accept it, as one act.
   *
   * Accepting alone would only flip a manifest flag: the slot's task still names the later render,
   * so the runner and the exporter would go on using it. The adoption is what makes the picture
   * the slot's answer, and the accept is what the author meant by clicking Accept.
   *
   * The prompt these bytes were drawn from is kept rather than restamped with the slot's current
   * one, so the picture goes on reporting the drift it really has.
   */
  async restoreAsset(hash: string): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.restoreAsset(hash);
  }

  async previewReplace(hash: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewReplace(hash);
  }

  /**
   * Put an outside file in the place of a picture the project generated: upload it, then adopt
   * it onto the slot those bytes fill. It is a single act, so a file that lands but cannot be
   * adopted reports that in one answer — `uploadAsset` produces that message.
   */
  async replaceAsset(
    hash: string,
    file: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    return this.assetPart.replaceAsset(hash, file);
  }

  async previewRedraw(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewRedraw(hash, prompt, title);
  }

  /**
   * Draw a concept again, from an edited prompt or the same one. A concept is the one asset whose
   * prompt is authored rather than derived, so it is the one asset an author can rewrite; the
   * result is a new sketch beside the old one, because bytes are content-addressed.
   */
  async redrawAsset(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    return this.assetPart.redrawAsset(hash, prompt, title);
  }

  async previewPromote(hash: string, variant: string): Promise<{ ok: boolean; message: string }> {
    return this.assetPart.previewPromote(hash, variant);
  }

  /**
   * Promote a concept to the location plate the planner would have rendered: the variant goes onto
   * the sheet, the bytes are re-recorded as a `location_ref`, and that plate's task is logged
   * `done` so the next run adopts the sketch rather than rendering over it.
   */
  async promoteAsset(
    hash: string,
    variant: string,
    description: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    return this.assetPart.promoteAsset(hash, variant, description);
  }
}
