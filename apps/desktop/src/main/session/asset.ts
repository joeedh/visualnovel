import type { AdoptVia } from '@vn/artgen';
import * as info from './asset/info.js';
import * as approval from './asset/approval.js';
import * as regenerate from './asset/regenerate.js';
import * as art from './asset/art.js';
import * as concept from './asset/concept.js';
import * as upload from './asset/upload.js';
import * as adopt from './asset/adopt.js';
import type { WorkspaceSession } from './core.js';

/**
 * The asset surface's behavior. Each method delegates to the module under `asset/` that holds
 * its rule, passing the session along.
 */
export class AssetPart {
  constructor(private readonly session: WorkspaceSession) {}

  /** Lists every manifest asset with its label and slot. */
  assetLibrary() {
    return info.assetLibrary(this.session);
  }

  /** Everything the asset editor draws for one asset, or `null` for an unknown hash. */
  assetInfo(hash: string) {
    return info.assetInfo(this.session, hash);
  }

  /** Whether accepting this asset would be allowed, and why not. */
  previewAccept(hash: string) {
    return approval.previewAccept(this.session, hash);
  }

  /** Marks an asset as approved by the author. */
  acceptAsset(hash: string) {
    return approval.acceptAsset(this.session, hash);
  }

  /** Whether taking approval back off this asset would be allowed. */
  previewUnapprove(hash: string) {
    return approval.previewUnapprove(this.session, hash);
  }

  /** Takes approval back off an asset. */
  unapproveAsset(hash: string) {
    return approval.unapproveAsset(this.session, hash);
  }

  /** What `asset.regenerate` would do, without doing it. */
  previewRegenerate(hash: string) {
    return regenerate.previewRegenerate(this.session, hash);
  }

  /** Puts an asset's task back to `pending` so the next run re-renders it. */
  regenerateAsset(hash: string) {
    return regenerate.regenerateAsset(this.session, hash);
  }

  /** The task one slot's picture is, and what drawing it would do. */
  drawing(slot: string) {
    return regenerate.drawing(this.session, slot);
  }

  /** What `pipeline.draw` would do, without doing it. */
  previewDraw(slot: string) {
    return regenerate.previewDraw(this.session, slot);
  }

  /** Draws one slot, requeueing its task where it has already run. */
  drawSlot(slot: string) {
    return regenerate.drawSlot(this.session, slot);
  }

  /** What `art.setNotes` would do, without writing it. */
  previewArtNotes(target: string, notes: string) {
    return art.previewArtNotes(this.session, target, notes);
  }

  /** Writes one art-notes rung. */
  setArtNotes(target: string, notes: string) {
    return art.setArtNotes(this.session, target, notes);
  }

  /** What `art.setSeed` would do, without writing it. */
  previewArtSeed(target: string, seed: number | null) {
    return art.previewArtSeed(this.session, target, seed);
  }

  /** Writes one rung's image seed. */
  setArtSeed(target: string, seed: number | null) {
    return art.setArtSeed(this.session, target, seed);
  }

  /** What `art.setModel` would do, without writing it. */
  previewArtModel(target: string, model: string) {
    return art.previewArtModel(this.session, target, model);
  }

  /** Writes one rung's image model. */
  setArtModel(target: string, model: string) {
    return art.setArtModel(this.session, target, model);
  }

  /** What `art.generate` would draw, without spending the call. */
  previewConcept(sentence: string, subject: string) {
    return concept.previewConcept(this.session, sentence, subject);
  }

  /** Draws one concept image from a sentence. */
  drawConcept(sentence: string, subject: string) {
    return concept.drawConcept(this.session, sentence, subject);
  }

  /** What `asset.upload` would bring in, without writing anything. */
  previewUpload(file: string, title: string, slot = '', replace = false) {
    return upload.previewUpload(this.session, file, title, slot, replace);
  }

  /** Brings an outside image into the base asset store. */
  uploadAsset(file: string, title: string, slot = '', replace = false) {
    return upload.uploadAsset(this.session, file, title, slot, replace);
  }

  /** What `asset.adopt` would make this picture, without writing anything. */
  previewAdopt(hash: string, slot: string, replace: boolean) {
    return adopt.previewAdopt(this.session, hash, slot, replace);
  }

  /** Records bytes already in the store as a slot's output. */
  adoptAsset(hash: string, slot: string, replace: boolean, via: AdoptVia = 'adopt') {
    return adopt.adoptAsset(this.session, hash, slot, replace, via);
  }

  /** Copies one asset's bytes to a path the author chose. */
  exportAsset(hash: string, file: string) {
    return upload.exportAsset(this.session, hash, file);
  }

  /** What `asset.restore` would put back, without writing it. */
  previewRestore(hash: string) {
    return adopt.previewRestore(this.session, hash);
  }

  /** Puts an older take back in its slot and accepts it. */
  restoreAsset(hash: string) {
    return adopt.restoreAsset(this.session, hash);
  }

  /** What `asset.replace` would replace, before the chooser is opened. */
  previewReplace(hash: string) {
    return adopt.previewReplace(this.session, hash);
  }

  /** Puts an outside file in the place of a generated picture. */
  replaceAsset(hash: string, file: string) {
    return adopt.replaceAsset(this.session, hash, file);
  }

  /** What `art.redraw` would draw, without spending the call. */
  previewRedraw(hash: string, prompt: string, title: string) {
    return concept.previewRedraw(this.session, hash, prompt, title);
  }

  /** Draws a concept again, from an edited prompt or the same one. */
  redrawAsset(hash: string, prompt: string, title: string) {
    return concept.redrawAsset(this.session, hash, prompt, title);
  }

  /** What `art.promote` would do, without writing anything. */
  previewPromote(hash: string, variant: string) {
    return concept.previewPromote(this.session, hash, variant);
  }

  /** Promotes a concept to the location plate the planner would have rendered. */
  promoteAsset(hash: string, variant: string, description: string) {
    return concept.promoteAsset(this.session, hash, variant, description);
  }

  /**
   * The sidebar's logical tree plus per-entity backlinks. One load, one manifest, one storyboard
   * read per scene — which is exactly why this is not folded into `workspace:index`, the shape
   * the agent refetches every turn.
   */
}
