import { applyCharacterEdit, applyLocationEdit, docToMarkdown } from '@vn/model';
import { entityDoc, readShots, writeShots } from '@vn/store';
import { fileCache } from '../workspace/filecache.js';
import {
  adopt,
  adoptionOf,
  composePrompt,
  condensePrompt,
  coverage,
  cycleRefusal,
  effectiveChunks,
  enabledChunks,
  overrideAt,
  parseSlot,
  refCycle,
  refDrift,
  renderPrompt,
  resolveBinding,
  rungOf,
  slotKey,
  slotLabel,
  slotOf,
  type PromptRung,
} from '@vn/artgen';
import type { PromptChunk, PromptOverride, TaskInputs } from '@vn/types';
import { type TaskKind } from '@vn/types';
import { labelAssets, labelContext } from '../assets/assetlabel.js';
import { deriveChunks } from '../assets/assetprompt.js';
import { applyPromptEdit, type PromptEdit } from '../agent/promptedit.js';
import type { ChunkRefInfo, PromptView } from '../../shared/prompt.js';
import type {
  WorkspaceSession,
  LoadedProject,
  ChunkOp,
  ClearPart,
  PromptResult,
  PromptWriteResult,
} from './core.js';
import {
  relPath,
  readAllShots,
  withPromptOverride,
  characterOverrideEdit,
  locationOverrideEdit,
  frozenReason,
  loadProject,
} from './core.js';

export class PromptPart {
  constructor(private readonly session: WorkspaceSession) {}

  async promptView(hash: string): Promise<PromptView | null> {
    return this.promptViewOf(await loadProject(this.session.dir), hash);
  }

  /**
   * The reference strip for each chunk: the pin, what it is called, the slot it follows and whether
   * that slot has moved. One label pass and one manifest read, shared by every chunk on the card.
   */
  private chunkRefs(
    project: LoadedProject,
    override: PromptOverride | undefined,
  ): (chunk: string) => ChunkRefInfo[] {
    if (!override?.refs) return () => [];
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const names = labelAssets(manifest, labels);
    const ctx = { ...labels, assets: manifest };
    return (chunk) =>
      (override.refs?.[chunk] ?? []).map((ref) => ({
        pin  : ref.pin,
        ext  : ref.ext,
        label: names.get(ref.pin) ?? ref.pin.slice(0, 8),
        ...(ref.from ? { from: slotKey(ref.from) } : {}),
        ...(refDrift(ref, ctx) ? { drift: true } : {}),
      }));
  }

  /** {@link promptView} against a project already loaded — what `assetInfo` folds in. */
  async promptViewOf(project: LoadedProject, hash: string): Promise<PromptView | null> {
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return null;
    const shots = await readAllShots(project);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const chunks = deriveChunks(asset, ctx);
    if (!chunks) {
      // Nothing to compose: a concept, whose prompt was typed rather than derived, or an asset the
      // project has stopped describing. Either way the recorded prompt is all there is to show — a
      // concept as the one `request` chunk it was asked for, so the pane draws one kind of card.
      const text = asset.prompt ?? '';
      return {
        hash,
        mode: 'custom',
        text,
        chunks:
          asset.kind === 'concept'
            ? [
                {
                  key     : 'request',
                  category: 'request',
                  origin  : { kind: 'request' },
                  text,
                  derived: text,
                  muted  : false,
                },
              ]
            : [],
        held   : false,
        missing: [],
        frozen : frozenReason(asset.kind),
      };
    }

    const rung = rungOf(asset);
    const override = rung ? overrideAt(rung, { model: project.model, shots }) : undefined;
    const composed = composePrompt(chunks, override);
    // Only a whole-prompt rewrite can lose a clause. In chunks mode the composed text is built
    // directly from the chunks, so marking them would say "not found" about words that are
    // demonstrably there.
    const marks =
      composed.mode === 'chunks'
        ? undefined
        : new Map(
            coverage(enabledChunks(composed.chunks), composed.text).map((c) => [c.key, c.found]),
          );
    const refsOf = this.chunkRefs(project, override);
    return {
      hash,
      mode   : composed.mode,
      text   : composed.text,
      chunks: composed.chunks.map((c) => ({
        key     : c.key,
        category: c.category,
        origin  : c.origin,
        ...(c.also ? { also: c.also } : {}),
        text   : c.text,
        derived: c.derived,
        ...(c.edit ? { edit: c.edit } : {}),
        ...(c.authored === undefined ? {} : { authored: c.authored }),
        muted: c.muted,
        ...(c.editStale === undefined ? {} : { editStale: c.editStale }),
        ...(marks?.has(c.key) ? { represented: marks.get(c.key)! } : {}),
        ...(refsOf(c.key).length ? { refs: refsOf(c.key) } : {}),
      })),
      held   : composed.held,
      missing: marks ? [...marks].filter(([, found]) => !found).map(([key]) => key) : [],
      ...(override?.custom ? { custom: override.custom } : {}),
      ...(override?.agent
        ? {
            agent: {
              ...(override.agent.modelId ? { modelId: override.agent.modelId } : {}),
              ...(override.agent.at ? { at: override.agent.at } : {}),
            },
          }
        : {}),
    };
  }

  /** What one prompt edit would do, without writing it — every `prompt.*` command's `check`. */
  private async previewPrompt(hash: string, edit: PromptEdit): Promise<PromptResult> {
    const project = await loadProject(this.session.dir);
    const decided = await this.promptPlan(project, hash, edit);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /** Write one prompt edit at the rung that owns the picture. */
  private async writePrompt(hash: string, edit: PromptEdit): Promise<PromptWriteResult> {
    const project = await loadProject(this.session.dir);
    const decided = await this.promptPlan(project, hash, edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    return { ok: true, message: decided.note, written: [relPath(this.session.dir, decided.file)] };
  }

  previewPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'chunk', chunk, how: op, text });
  }

  setPromptChunk(
    hash: string,
    chunk: string,
    op: ChunkOp,
    text: string,
  ): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'chunk', chunk, how: op, text });
  }

  previewMoveChunk(hash: string, chunk: string, after: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'move', chunk, after });
  }

  movePromptChunk(hash: string, chunk: string, after: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'move', chunk, after });
  }

  previewCustomPrompt(hash: string, text: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'custom', text });
  }

  setCustomPrompt(hash: string, text: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'custom', text });
  }

  previewClearPrompt(hash: string, part: ClearPart): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'clear', part });
  }

  clearPrompt(hash: string, part: ClearPart): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'clear', part });
  }

  /**
   * The `ChunkRef` an address would attach, and the cycle it would close if it closed one
   * (`docs/plans/archive/INDEX.md#chunked-prompts` §14).
   *
   * Enforcement is here, at write time, rather than in the planner: refusing at plan time would mean
   * the project is already broken on disk and the author meets a run failure instead of a rejected
   * gesture. A bare hash attaches with no `from`, because an upload or a concept carries its own
   * identity: there is no slot under it, so it can never drift.
   */
  private async addRefPlan(
    hash: string,
    chunk: string,
    ref: string,
  ): Promise<
    { ok: false; reason: string } | { ok: true; project: LoadedProject; edit: PromptEdit }
  > {
    const project = await loadProject(this.session.dir);
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };

    const binding = parseSlot(ref);
    if (!binding) {
      return {
        ok    : false,
        reason: `"${ref}" names no reference. Give an asset hash, or a slot: portrait:<character>, sheet:<character>/<outfit>/<angle>, plate:<location>/<variant>, shot:<scene>/<shot>.`,
      };
    }
    const labels = labelContext(project.model, project.graph);
    const pin = resolveBinding(binding, { ...labels, assets: project.store.manifest() });
    if (!pin) {
      return {
        ok    : false,
        reason: `Nothing fills ${slotLabel(binding)} today, so there is no image to attach.`,
      };
    }
    const target = project.store.manifest().find((a) => a.hash === pin);
    if (!target) {
      return {
        ok    : false,
        reason: `${slotLabel(binding)} names ${pin.slice(0, 8)}, which is not in the manifest.`,
      };
    }

    const shots = await readAllShots(project);
    const from = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    if (from) {
      const path = refCycle(from, binding, { model: project.model, shots });
      if (path) return { ok: false, reason: `Cannot attach: ${cycleRefusal(path)}.` };
    }
    return {
      ok: true,
      project,
      edit: {
        op: 'addRef',
        chunk,
        ref: { pin, ext: target.ext, ...(binding.kind === 'asset' ? {} : { from: binding }) },
      },
    };
  }

  /** What `prompt.addRef` would attach, and every reason it would not. */
  async previewAddRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    const plan = await this.addRefPlan(hash, chunk, ref);
    if (!plan.ok) return { ok: false, message: plan.reason };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
  }

  /** Attach a reference image to one chunk. It re-keys the task, so the picture re-renders. */
  async addPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    const plan = await this.addRefPlan(hash, chunk, ref);
    if (!plan.ok) return { ok: false, message: plan.reason, written: [] };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    return { ok: true, message: decided.note, written: [relPath(this.session.dir, decided.file)] };
  }

  previewDropRef(hash: string, chunk: string, ref: string): Promise<PromptResult> {
    return this.previewPrompt(hash, { op: 'dropRef', chunk, ref });
  }

  dropPromptRef(hash: string, chunk: string, ref: string): Promise<PromptWriteResult> {
    return this.writePrompt(hash, { op: 'dropRef', chunk, ref });
  }

  /**
   * What a repin would move, decided against one load: the slot the reference names, the hash that
   * slot holds today, and — when the author is re-approving — the `done` record that keeps the
   * existing bytes (`docs/plans/archive/INDEX.md#chunked-prompts` §13). Both the check and the write
   * ask this, so they cannot disagree.
   *
   * The adopted task's inputs are the previous node's with the old pin swapped for the new one in
   * place. That is exact rather than a re-derivation: a repin touches only the authored tail of
   * `refs`, so the result is provably what the planner will compute. If the derived half moved too,
   * the adopted node is simply an orphan and the picture re-renders — the fail-safe direction.
   */
  private async repinPlan(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        project: LoadedProject;
        edit: PromptEdit;
        note: string;
        adoption?: () => Promise<void>;
      }
  > {
    const project = await loadProject(this.session.dir);
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const found = await this.promptChunksOf(project, hash);
    if (!found.ok) return found;

    const pinned = found.override?.refs?.[chunk]?.find(
      (r) => r.pin === ref || r.pin.startsWith(ref),
    );
    if (!pinned) {
      return { ok: false, reason: `No reference "${ref}" on "${chunk}" of ${hash.slice(0, 8)}.` };
    }
    if (!pinned.from) {
      return {
        ok    : false,
        reason: `${pinned.pin.slice(0, 8)} is an unlinked reference — it names no slot, so there is nothing to repin it to.`,
      };
    }
    const to = resolveBinding(pinned.from, {
      ...labelContext(project.model, project.graph),
      assets: project.store.manifest(),
    });
    if (!to) {
      return {
        ok    : false,
        reason: `Nothing fills that slot today, so there is no hash to repin ${pinned.pin.slice(0, 8)} to.`,
      };
    }
    const target = project.store.manifest().find((a) => a.hash === to);
    if (!target)
      return {
        ok    : false,
        reason: `The slot names ${to.slice(0, 8)}, which is not in the manifest.`,
      };
    const edit: PromptEdit = { op: 'repin', chunk, ref: pinned.pin, to, ext: target.ext };

    if (regenerate) {
      return {
        ok: true,
        project,
        edit,
        note: `Repin to ${to.slice(0, 8)} and re-render — the task is newly keyed, so the next run draws it again.`,
      };
    }

    const node = project.graph.get(asset.sourceTask);
    if (!node || !('refs' in node.inputs)) {
      return {
        ok    : false,
        reason: `${hash.slice(0, 8)} has no task on record to re-approve against, so it can only be repinned with regenerate=true.`,
      };
    }
    const inputs = {
      ...node.inputs,
      refs: node.inputs.refs.map((r) =>
        r.hash === pinned.pin ? { hash: to, ext: target.ext } : r,
      ),
    } as TaskInputs[TaskKind];
    const req = { kind: node.kind, inputs, output: asset };
    const ctx = {
      has : (h: string) => project.store.has(h),
      node: (h: string) => project.graph.get(h),
    };
    const decided = adoptionOf(req, ctx);
    if (!decided.ok) return { ok: false, reason: decided.reason };
    return {
      ok: true,
      project,
      edit,
      note: `Repin to ${to.slice(0, 8)} and keep these bytes — the newly-keyed task is recorded done with ${hash.slice(0, 8)}, so nothing re-renders.`,
      adoption: async () => {
        const done = await adopt(project.paths, req, ctx);
        if (!done.ok) throw new Error(done.reason);
      },
    };
  }

  async previewRepin(
    hash: string,
    chunk: string,
    ref: string,
    regenerate: boolean,
  ): Promise<PromptResult> {
    const plan = await this.repinPlan(hash, chunk, ref, regenerate);
    if (!plan.ok) return { ok: false, message: plan.reason };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    return decided.ok ? { ok: true, message: plan.note } : { ok: false, message: decided.reason };
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
    const plan = await this.repinPlan(hash, chunk, ref, regenerate);
    if (!plan.ok) return { ok: false, message: plan.reason, written: [] };
    const decided = await this.promptPlan(plan.project, hash, plan.edit);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    await decided.write();
    if (plan.adoption) await plan.adoption();
    return { ok: true, message: plan.note, written: [relPath(this.session.dir, decided.file)] };
  }

  /**
   * What `prompt.condense` would spend the call on. It cannot know what the model will write, so
   * this answers the two questions that do not need it: is there anything to condense, and is
   * there a hand-written prompt in the way.
   */
  async previewCondense(hash: string, force: boolean): Promise<PromptResult> {
    const view = await this.session.promptView(hash);
    if (!view) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (view.frozen) return { ok: false, message: view.frozen };
    if (view.mode === 'custom' && !force) {
      return {
        ok     : false,
        message:
          `A custom prompt is already written. prompt.condense(hash='${hash.slice(0, 8)}' ` +
          'force=true) reconciles it against the chunks instead of discarding it.',
      };
    }
    const n = view.chunks.filter((c) => !c.muted).length;
    return { ok: true, message: `Condense ${n} clause${n === 1 ? '' : 's'} into one prompt.` };
  }

  /**
   * Condense the chunks into one prompt and store it at the rung. The condensation is held the
   * moment the chunks move under it — `composePrompt` keeps sending this text rather than the
   * fresh chunks, because re-rendering would move the task hash and re-render the picture.
   */
  async condenseAssetPrompt(hash: string, force: boolean): Promise<PromptWriteResult> {
    const allowed = await this.session.previewCondense(hash, force);
    if (!allowed.ok) return { ok: false, message: allowed.message, written: [] };
    const project = await loadProject(this.session.dir);
    const decided = await this.promptChunksOf(project, hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { chunks, override } = decided;
    const given = enabledChunks(effectiveChunks(chunks, override));

    const result = await this.session.while('condensing a prompt', async () => {
      const text = await this.session.projectPart.condensingText(project, renderPrompt(given));
      return condensePrompt(given, text, force ? override?.custom : undefined);
    });
    if (result.source === 'fallback') {
      return {
        ok     : false,
        message: 'No text model answered, so nothing was condensed and nothing was written.',
        written: [],
      };
    }

    const written = await this.writePrompt(hash, {
      op     : 'agent',
      text   : result.prompt,
      modelId: project.config.models.text,
      at     : new Date().toISOString(),
    });
    if (!written.ok) return written;
    const lost = result.coverage.filter((c) => !c.found).map((c) => c.key);
    return {
      ...written,
      message:
        `Condensed ${given.length} clauses into one prompt.` +
        (lost.length ? ` Not found in the result: ${lost.join(', ')}.` : ''),
    };
  }

  /**
   * Which chunks the effective prompt still appears to say — `prompt.check`, and the same answer
   * the pane's marks come from. A read, so it never refuses over mode: in chunks mode nothing can
   * be missing, which is itself worth being able to ask.
   */
  async checkPrompt(hash: string): Promise<PromptResult> {
    const view = await this.session.promptView(hash);
    if (!view) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (!view.missing.length) {
      return { ok: true, message: `Every clause is represented in the ${view.mode} prompt.` };
    }
    return {
      ok     : true,
      message: `Not found in the ${view.mode} prompt: ${view.missing.join(', ')}.`,
    };
  }

  /** `project.yaml` as the app reads it, for the Project editor. */
  private async promptChunksOf(
    project: LoadedProject,
    hash: string,
  ): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        rung: PromptRung;
        chunks: PromptChunk[];
        override: PromptOverride | undefined;
      }
  > {
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const shots = await readAllShots(project);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const chunks = deriveChunks(asset, ctx);
    const rung = rungOf(asset);
    if (!chunks || !rung) return { ok: false, reason: frozenReason(asset.kind) };
    return { ok: true, rung, chunks, override: overrideAt(rung, { model: project.model, shots }) };
  }

  /**
   * The rule behind every `prompt.*` write, decided once against a fresh load: which rung owns
   * this picture, what the edit does to what is stored there, and which file that lands in.
   *
   * The two writers are the same two `setArtNotes` has — an entity sheet through `@vn/model`'s
   * `apply*Edit`, or `work/shots/<sceneId>.json` — because an override lives beside the art notes
   * it overrides, and this is the only place in the app that split appears.
   */
  private async promptPlan(
    project: LoadedProject,
    hash: string,
    edit: PromptEdit,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; note: string; file: string; write: () => Promise<void> }
  > {
    const found = await this.promptChunksOf(project, hash);
    if (!found.ok) return found;
    const { rung, chunks, override } = found;
    const next = applyPromptEdit(chunks, override, edit);
    if (!next.ok) return next;

    if (rung.kind === 'shot') {
      const scene = project.model.scenes.get(rung.sceneId);
      if (!scene) return { ok: false, reason: `No scene "${rung.sceneId}" to write to.` };
      return {
        ok   : true,
        note : next.note,
        file : project.paths.shotsFile(rung.sceneId),
        write: async () => {
          const loaded = await readShots(
            project.paths,
            scene.id,
            new Set(scene.lines.map((l) => l.id)),
          );
          if (!loaded) throw new Error(`Scene "${scene.id}" has no storyboard to write to.`);
          await writeShots(
            project.paths,
            scene.id,
            loaded.shots.map((s) =>
              s.id === rung.shotId ? withPromptOverride(s, next.override) : s,
            ),
          );
        },
      };
    }

    const location = rung.kind === 'variant';
    const kind = location ? 'location' : 'character';
    const id = rung.kind === 'variant' ? rung.locationId : rung.characterId;
    const docs = location ? project.inputs.locationDocs : project.inputs.characterDocs;
    const doc = entityDoc(docs, id);
    if (!doc) return { ok: false, reason: `No sheet on disk for ${kind} "${id}".` };
    return {
      ok   : true,
      note : next.note,
      file : doc.file,
      write: async () => {
        const edited =
          rung.kind === 'variant'
            ? applyLocationEdit(doc.doc, locationOverrideEdit(project, rung, next.override))
            : applyCharacterEdit(doc.doc, characterOverrideEdit(project, rung, next.override));
        if (!edited.ok) throw new Error(`Edit rejected: ${edited.diagnostic.message}`);
        await fileCache.write(doc.file, docToMarkdown(edited.value.doc));
      },
    };
  }

  /**
   * The rule behind both concept halves, decided once against a fresh load: is there something to
   * draw, is there a root to write it into, and what would the prompt say.
   */
}
