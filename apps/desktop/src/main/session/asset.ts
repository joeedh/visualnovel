import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { clearCharacterApproval, entityFile, isBaseKind, removeApprovedPortrait } from '@vn/store';
import { activeOutputs, type GraphJournalRecord } from '@vn/gengraph';
import { appendGraphJournal, graphJournalFile, invalidateGenGraph } from '@vn/gengraph/state';
import { logTask } from '@vn/taskgraph';
import { sha256 } from '@vn/util';
import { basePromptOf, baseRefusal, isApproved, slotOfTask } from '@vn/pipeline';
import {
  adoptSlot,
  adoptionForSlot,
  artNotesOf,
  artSeedOf,
  assetApproved,
  assetPrereqs,
  formatSubject,
  generateConcept,
  matchSubject,
  parseSlot,
  parseSubject,
  prereqRefusal,
  promoteConcept,
  promotionOf,
  redrawConcept,
  redrawOf,
  rungsFor,
  setArtNotes as writeArtNotes,
  setArtSeed as writeArtSeed,
  slotKey,
  slotLabel,
  slotOf,
  supersededBy,
  subjectEntity,
  uploadOf,
  uploadReference,
  type AdoptSlotPlan,
  type ConceptRequest,
} from '@vn/artgen';
import type { AnyTask, RefBinding } from '@vn/types';
import type { AssetInfo, AssetListing } from '../../shared/ipc.js';
import { graphSlugs, readGraph } from '../doctree/graphs.js';
import { labelAssets, labelContext } from '../assets/assetlabel.js';
import { derivePrompt } from '../assets/assetprompt.js';
import type { WorkspaceSession, LoadedProject } from './core.js';
import {
  relPath,
  ACCEPTABLE,
  suspensionsOf,
  readAllShots,
  loadProject,
  buildProviders,
} from './core.js';

export class AssetPart {
  constructor(private readonly session: WorkspaceSession) {}

  async assetLibrary(): Promise<AssetListing[]> {
    const project = await loadProject(this.session.dir);
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const names = labelAssets(manifest, labels);
    return manifest.map((asset) => {
      const slot = slotOf(asset, labels.angleOf?.(asset.sourceTask));
      return {
        hash    : asset.hash,
        ext     : asset.ext,
        kind    : asset.kind,
        label   : names.get(asset.hash) ?? asset.hash,
        accepted: assetApproved(asset, project.model),
        ...(slot ? { slot: slotKey(slot) } : {}),
      };
    });
  }

  /**
   * Everything the asset editor draws for one asset: what the bytes are, the prompt they were
   * made from, the prompt the builders would write now, and the art-notes rungs that reach it.
   * `null` when the manifest has never heard of the hash.
   */
  async assetInfo(hash: string): Promise<AssetInfo | null> {
    const project = await loadProject(this.session.dir);
    const manifest = project.store.manifest();
    const asset = manifest.find((a) => a.hash === hash);
    if (!asset) return null;

    const shots = await readAllShots(project);
    const suspended = suspensionsOf(project, shots).get(hash);
    const task = project.graph.get(asset.sourceTask);
    const ctx = { model: project.model, config: project.config, shots, ...(task ? { task } : {}) };
    const derived = derivePrompt(asset, ctx);
    // The prompt as sent carries any `Corrections:` clause P7 appended; the planner hashed the base.
    const recorded = asset.prompt === undefined ? undefined : basePromptOf(asset.prompt);
    const view = await this.session.promptPart.promptViewOf(project, hash);
    const labels = labelContext(project.model, project.graph);
    const label = labelAssets(manifest, labels).get(hash) ?? hash;
    const prereqs = assetPrereqs(asset, { ...labels, assets: manifest, shots });
    // Only for the kinds that can be accepted at all: a portrait, a concept and an upload are each
    // refused by name already, and a second sentence beside those reads as a second rule. Their
    // prereqs are still listed, because what a sketch was drawn from is worth showing regardless.
    const unapproved = ACCEPTABLE.has(asset.kind) ? prereqRefusal(label, prereqs) : undefined;
    const from = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    const current = from ? this.session.gatePart.slotTask(project, from, shots) : undefined;
    // A slot only counts while these are the bytes in it: a superseded render keeps its binding,
    // and a pane offering to replace a superseded render would supersede a picture already
    // moved past.
    const slot = from && task?.status === 'done' && task.output === asset.hash ? from : undefined;
    const failure = from
      ? this.session.gatePart.failureOf(project, current, asset.sourceTask)
      : undefined;
    // Reported only once the bytes exist, so the pane never follows a hash the manifest cannot
    // answer for.
    const holder = current === undefined ? undefined : project.graph.get(current)?.output;
    const newer =
      holder !== undefined && holder !== asset.hash && manifest.some((a) => a.hash === holder)
        ? holder
        : undefined;
    // Only a concept bound to a location promotes to a plate, and only that strip asks for a
    // variant, so nothing else pays for the lookup.
    const conceptOf = asset.kind === 'concept' ? asset.satisfies[0]?.locationId : undefined;
    const locationVariants = conceptOf
      ? (project.model.locations.get(conceptOf)?.variants ?? []).map((v) => v.id)
      : undefined;
    return {
      hash: asset.hash,
      ext : asset.ext,
      kind: asset.kind,
      label,
      base      : isBaseKind(asset.kind),
      accepted  : asset.accepted,
      sourceTask: asset.sourceTask,
      ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }),
      ...(asset.title === undefined ? {} : { title: asset.title }),
      ...(derived === undefined ? {} : { derived }),
      // An unknown derivation is not evidence of drift — it means the project no longer describes
      // this asset, which the editor says a different way.
      stale: derived !== undefined && recorded !== undefined && derived !== recorded,
      ...(suspended ? { suspended: suspended.reason } : {}),
      ...(slot ? { slot: slotKey(slot) } : {}),
      ...(from ? { drawnFor: slotKey(from) } : {}),
      ...(locationVariants ? { locationVariants } : {}),
      ...(newer ? { newerTake: newer } : {}),
      ...(failure ? { failure } : {}),
      prereqs,
      ...(unapproved ? { unapproved } : {}),
      rungs: rungsFor(asset, { model: project.model, shots }),
      ...(project.config.image_params.seed === undefined
        ? {}
        : { configSeed: project.config.image_params.seed }),
      ...(view ? { promptView: view } : {}),
    };
  }

  /**
   * Whether accepting this asset is a question worth answering. Three kinds are refused by name:
   * a portrait, because approving one also writes `character.md` and `approved.png` and that is
   * `gate.approve`; a concept, because nothing downstream consumes one, so `accepted` would
   * mean nothing; and a reference, because nothing generated it — it counts by being pointed at.
   * Already accepted is not a refusal — re-accepting is how an author changes their mind.
   */
  async previewAccept(hash: string): Promise<{ ok: boolean; message: string }> {
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (info.kind === 'portrait') {
      // The character rung is the widest one a portrait has, so its target names the character
      // without asking for the binding a second time.
      const who = info.rungs[0]?.target.split(':')[1];
      const call = who ? `(characterId='${who}' hash='${hash}')` : '';
      return {
        ok     : false,
        message: `${info.label} is a portrait; use gate.approve${call}, which also writes character.md and approved.png.`,
      };
    }
    if (info.kind === 'concept') {
      return {
        ok     : false,
        message: `${info.label} is a concept; nothing downstream consumes one. Use art.promote(hash='${hash}' variant=…) to make it a location plate.`,
      };
    }
    if (info.kind === 'reference') {
      return {
        ok     : false,
        message: `${info.label} is an upload; nothing generated it, so there is no work to bless. It counts by being pointed at with prompt.addRef.`,
      };
    }
    if (info.suspended) {
      // Accepting says these bytes are the answer, and a suspended asset was drawn against a
      // reference that has since moved.
      return {
        ok     : false,
        message: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
      };
    }
    // Checked after suspension deliberately: suspension is a claim about these bytes resting on a
    // reference that moved, which is more specific than a claim about other bytes upstream.
    if (info.unapproved) return { ok: false, message: info.unapproved };
    return {
      ok     : true,
      message: info.accepted
        ? `${info.label} is already accepted; would re-accept it.`
        : `Would accept ${info.label}.`,
    };
  }

  /**
   * Mark an asset as the accepted one for what it satisfies. Generic across both roots, and it
   * asks {@link previewAccept} itself rather than trusting that a check already ran — a caller
   * may skip the check, so the command cannot rely on it having happened.
   *
   * Accepting is exclusive per slot: the takes this one replaces are un-accepted in the same write,
   * because a slot with two accepted candidates cannot be resolved and reads as empty.
   */
  async acceptAsset(hash: string): Promise<{ ok: boolean; message: string }> {
    const allowed = await this.session.previewAccept(hash);
    if (!allowed.ok) return allowed;
    const project = await loadProject(this.session.dir);
    if (!project.store.has(hash)) return { ok: false, message: `No asset "${hash}" in the store.` };
    const assets = project.store.manifest();
    const asset = assets.find((a) => a.hash === hash);
    const ctx = { ...labelContext(project.model, project.graph), assets };
    await project.store.accept(hash, asset ? supersededBy(asset, ctx) : []);
    return { ok: true, message: `Accepted ${hash.slice(0, 8)}.` };
  }

  /**
   * Which character a portrait was drawn for, from its widest art-notes rung. The same lookup
   * `previewAccept` uses to name `gate.approve` in its refusal.
   */
  private portraitOwner(info: AssetInfo): string | undefined {
    return info.rungs[0]?.target.split(':')[1];
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
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    if (info.kind === 'concept' || info.kind === 'reference') {
      return {
        ok     : false,
        message: `${info.label} is a ${info.kind}; nothing ever approved it, so there is nothing to take back.`,
      };
    }
    if (info.kind === 'portrait') {
      const who = this.portraitOwner(info);
      if (!who) return { ok: false, message: `${info.label} names no character.` };
      const project = await loadProject(this.session.dir);
      const character = project.model.characters.get(who);
      if (!character || !isApproved(character)) {
        return { ok: false, message: `${who} has no approved portrait.` };
      }
      if (character.approvedPortrait !== hash) {
        return { ok: false, message: `${who}'s approved portrait is a different take.` };
      }
      return {
        ok     : true,
        message: `Would put ${who} back at the gate, dropping approved.png and the hash in their sheet.`,
      };
    }
    if (!info.accepted) return { ok: false, message: `${info.label} is not accepted.` };
    return { ok: true, message: `Would un-accept ${info.label}, leaving its slot unanswered.` };
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
    const allowed = await this.session.previewUnapprove(hash);
    if (!allowed.ok) return { ...allowed, written: [] };
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.`, written: [] };
    const project = await loadProject(this.session.dir);

    if (info.kind !== 'portrait') {
      await project.store.unaccept(hash);
      return {
        ok     : true,
        message: `Un-accepted ${info.label}.`,
        written: ['vngen/build/manifest.json'],
      };
    }

    const who = this.portraitOwner(info) ?? '';
    const file = entityFile(project.inputs.characterDocs, who);
    if (!file || !(await clearCharacterApproval(file))) {
      return { ok: false, message: `No character file for "${who}".`, written: [] };
    }
    await removeApprovedPortrait(project.paths, who);
    await project.store.unaccept(hash);
    return {
      ok     : true,
      message: `${who} is back at the approval gate.`,
      written: [
        `characters/${who}/character.md`,
        `vngen/work/characters/${who}/approved.png`,
        'vngen/build/manifest.json',
      ],
    };
  }

  /**
   * Whether a regeneration would land, and the task it would requeue. Shared by the check and the
   * write so the refusal a surface shows is the refusal the command gives.
   *
   * A `stale` asset is refused on purpose: its task is an orphan (the prompt moved on, so the
   * planner now wants a different hash), and requeueing it would spend a real image call
   * reproducing the picture the author just edited away from. `tasks.jsonl` is never pruned, so
   * without this the log's dead nodes stay re-runnable forever. The one stale asset that is not
   * refused is one whose slot has since failed: there the task to re-run is the one that gave up,
   * and no run will reach it on its own once its retry budget is spent.
   */
  private async regeneration(
    hash: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; task: AnyTask; note: string }> {
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    const project = await loadProject(this.session.dir);
    if (project.store.base.state === 'unavailable') {
      return {
        ok    : false,
        reason: baseRefusal(project.store.base) ?? 'Base assets are unavailable.',
      };
    }
    // A concept's `sourceTask` is a hash of the request and deliberately not a node, so the
    // generic "no task" refusal below would be true and useless. Redrawing one is its own act.
    if (info.kind === 'concept') {
      return {
        ok    : false,
        reason: `${info.label} is a concept: the planner never made it, so there is no task to re-run. Draw it again with art.redraw(hash='${hash}'), which takes an edited prompt.`,
      };
    }
    // Same shape as the concept refusal, for the same reason: an upload's `sourceTask` is a hash of
    // the request that brought the bytes in, and no node ever answered to it.
    if (info.kind === 'reference') {
      return {
        ok    : false,
        reason: `${info.label} is an upload: nothing generated it, so there is no task to re-run. Bring in a different image with asset.upload(file=…).`,
      };
    }
    const task = info.sourceTask ? project.graph.get(info.sourceTask) : undefined;
    if (!task) {
      return {
        ok    : false,
        reason: `${info.label} records no task in the graph, so there is nothing to re-run.`,
      };
    }
    // A re-render the project has already given up on is the picture the author is asking for,
    // not the one these bytes came from. The scheduler will not requeue it once its retry budget
    // is spent, and the orphan refusal below would send the author to a run that does nothing.
    if (info.failure?.later) {
      const later = project.graph.get(info.failure.task);
      if (later) {
        return {
          ok  : true,
          task: later,
          note: `Would re-run the ${later.kind} that gave up on ${info.label}. The picture on screen is the last one that got through, and it stays until the new render lands.`,
        };
      }
    }
    if (info.stale) {
      return {
        ok    : false,
        reason: `${info.label} was rendered from a prompt the project has since changed, so its task is an orphan. Run the pipeline — a fresh task is already planned for it.`,
      };
    }
    // With a fixed seed the same prompt and the same references give back the same bytes, so
    // say so rather than letting an author spend a call finding out.
    const seeded = project.config.image_params.seed !== undefined;
    return {
      ok: true,
      task,
      note: seeded
        ? `Would re-run ${task.kind} for ${info.label} — image_params.seed is fixed, so expect the same picture. Art notes are how the picture changes.`
        : `Would re-run ${task.kind} for ${info.label}.`,
    };
  }

  /** What `asset.regenerate` would do, without doing it. */
  async previewRegenerate(hash: string): Promise<{ ok: boolean; message: string }> {
    const decided = await this.regeneration(hash);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
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
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const decided = await this.regeneration(hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const project = await loadProject(this.session.dir);
    await logTask(project.paths, {
      ...decided.task,
      status: 'pending',
      output: undefined,
      error : undefined,
    });
    const written = [relPath(this.session.dir, project.paths.tasksLog)];
    const invalidated = await this.invalidateBound(project, decided.task);
    if (invalidated !== undefined) written.push(invalidated);
    return {
      ok     : true,
      message: `Queued ${decided.task.kind} ${decided.task.hash.slice(0, 8)} for re-run.`,
      written,
    };
  }

  /**
   * Invalidates the paid nodes feeding the graph bound to this task's slot, and reports the
   * journal that was appended to. Answers undefined when no graph claims the slot, which is
   * every task in a project that has authored none.
   */
  private async invalidateBound(
    project: LoadedProject,
    task: AnyTask,
  ): Promise<string | undefined> {
    const slot = slotOfTask(task, project.model);
    if (slot === undefined) return undefined;

    for (const slug of await graphSlugs(this.session.dir)) {
      const read = await readGraph(this.session.dir, slug);
      if (!read.ok) continue;

      const bound = activeOutputs(read.graph).find((output) => output.slot === slot);
      if (bound === undefined) continue;

      await invalidateGenGraph(
        read.graph,
        { record: (record: GraphJournalRecord) => appendGraphJournal(project.paths, slug, record) },
        [bound.id],
      );
      return relPath(this.session.dir, graphJournalFile(project.paths, slug));
    }
    return undefined;
  }

  /** What `art.setNotes` would do, without writing it. */
  async previewArtNotes(target: string, notes: string): Promise<{ ok: boolean; message: string }> {
    const { config, paths } = await loadProject(this.session.dir);
    const decided = await artNotesOf({ config, paths }, { target, notes });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /**
   * Write one art-notes rung, through the rule `vnauthor`'s `set_art_notes` runs — an entity rung
   * into the sheet the model was built from, a shot rung into `work/shots/<sceneId>.json`.
   */
  async setArtNotes(
    target: string,
    notes: string,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const { config, paths } = await loadProject(this.session.dir);
    const deps = { config, paths };
    const decided = await artNotesOf(deps, { target, notes });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const plan = await writeArtNotes(deps, { target, notes });
    return { ok: true, message: plan.note, written: [relPath(this.session.dir, plan.file)] };
  }

  /** What `art.setSeed` would do, without writing it. */
  async previewArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string }> {
    const { config, paths } = await loadProject(this.session.dir);
    const decided = await artSeedOf({ config, paths }, { target, seed });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
  }

  /** Write one rung's image seed, into the same two files `setArtNotes` writes. */
  async setArtSeed(
    target: string,
    seed: number | null,
  ): Promise<{ ok: boolean; message: string; written: string[] }> {
    const { config, paths } = await loadProject(this.session.dir);
    const deps = { config, paths };
    const decided = await artSeedOf(deps, { target, seed });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const plan = await writeArtSeed(deps, { target, seed });
    return { ok: true, message: plan.note, written: [relPath(this.session.dir, plan.file)] };
  }

  /**
   * The composed prompt for one asset: the chunks the builders derived, what the author's override
   * does to them, and the one string that would be sent. `null` when the manifest has never heard
   * of the hash.
   *
   * The pane reads this off `assetInfo`, so a picture and its prompt are one round trip; the
   * command is the same projection for an agent and for CDP.
   */
  private async conceptPlan(
    sentence: string,
    subject: string,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; note: string; project: LoadedProject; req: ConceptRequest }
  > {
    const said = sentence.trim();
    if (!said) return { ok: false, reason: 'Nothing to draw: the description is empty.' };
    const named = subject ? parseSubject(subject) : undefined;
    if (subject && !named) {
      return {
        ok    : false,
        reason: `"${subject}" names no subject; expected location:<id> or character:<id>.`,
      };
    }
    const project = await loadProject(this.session.dir);
    const refusal = baseRefusal(project.store.base);
    if (refusal) return { ok: false, reason: refusal };
    const bound = named ?? matchSubject(project.model, said);
    if (bound && !subjectEntity(project.model, bound)) {
      return { ok: false, reason: `No ${bound.kind} "${bound.id}" in this project.` };
    }
    const of = bound ? `of ${formatSubject(bound)}` : 'bound to nothing in the project';
    return {
      ok  : true,
      note: `Would draw a concept ${of}. It is a sketch — nothing in the pipeline plans or renders it.`,
      project,
      req: { sentence: said, ...(bound ? { subject: bound } : {}) },
    };
  }

  /** What `art.generate` would draw, without spending the call. */
  async previewConcept(
    sentence: string,
    subject: string,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.conceptPlan(sentence, subject);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
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
    const decided = await this.conceptPlan(sentence, subject);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, req } = decided;
    const result = await this.session.while('a concept image', async () => {
      const providers = await buildProviders(project, this.session.mock);
      return generateConcept(
        {
          config: project.config,
          model : project.model,
          store : project.store,
          image : providers.image,
        },
        req,
      );
    });
    const of = result.subject ? ` of ${formatSubject(result.subject)}` : '';
    return {
      ok     : true,
      message: `Drew a concept${of}: ${result.ref.hash.slice(0, 8)}.`,
      hash   : result.ref.hash,
      written: [
        relPath(this.session.dir, result.file),
        relPath(this.session.dir, project.paths.baseManifest),
      ],
    };
  }

  /**
   * The rule behind both upload halves: read the bytes once, then let `uploadOf` say everything
   * that can be refused. A relative path is resolved against the project, so a command reads the
   * same file the file picker named.
   */
  private async uploadPlan(
    file: string,
    title: string,
    slot: string,
    replace: boolean,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; project: LoadedProject; path: string; note: string; slot?: RefBinding }
  > {
    const said = file.trim();
    if (!said) return { ok: false, reason: 'Nothing to upload: no file was named.' };
    const path = isAbsolute(said) ? said : join(this.session.dir, said);
    const project = await loadProject(this.session.dir);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return { ok: false, reason: `Cannot read ${relPath(this.session.dir, path)}.` };
    }
    const decided = uploadOf(project.store, { file: path, title, bytes });
    if (!decided.ok) return { ok: false, reason: decided.reason };
    if (!slot.trim()) return { ok: true, project, path, note: decided.plan.note };

    // Both refusals before either write: an upload that names a slot is one act, and hearing
    // "that slot is already rendered" after the bytes are copied is hearing it too late.
    const hash = sha256(bytes);
    const adoption = await this.adoptPlan(hash, slot, replace, bytes);
    if (!adoption.ok) return { ok: false, reason: adoption.reason };
    const supersede = adoption.plan.supersedes
      ? ` It supersedes the render ${adoption.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
      : ' The next run adopts it instead of rendering one.';
    return {
      ok: true,
      project,
      path,
      slot: adoption.slot,
      note: `Would bring ${basename(path)} in as ${hash.slice(0, 8)} and make it the ${adoption.plan.label}.${supersede}`,
    };
  }

  /** What `asset.upload` would bring in, without writing anything. */
  async previewUpload(
    file: string,
    title: string,
    slot = '',
    replace = false,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.uploadPlan(file, title, slot, replace);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
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
    const decided = await this.uploadPlan(file, title, slot, replace);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, path } = decided;
    const result = await uploadReference({ store: project.store }, { file: path, title });
    const already = result.known ? ' It was already in the store; nothing new was written.' : '';
    const uploaded = `Uploaded "${result.title}" as ${result.ref.hash.slice(0, 8)}.${already}`;
    const written = [
      relPath(this.session.dir, result.stored),
      relPath(this.session.dir, project.paths.baseManifest),
    ];
    if (!decided.slot) return { ok: true, message: uploaded, hash: result.ref.hash, written };

    // The bytes are in by now, so a refusal here is recoverable rather than lost — which is what
    // the message has to say, because the author's file did land somewhere.
    const adopted = await this.session.adoptAsset(result.ref.hash, slot, replace);
    if (!adopted.ok) {
      return {
        ok     : false,
        message: `${uploaded} It could not be adopted, and stays a reference: ${adopted.message} Finish with asset.adopt(hash='${result.ref.hash}' slot='${slot}').`,
        hash   : result.ref.hash,
        written,
      };
    }
    return {
      ok     : true,
      message: `${uploaded} ${adopted.message}`,
      hash   : result.ref.hash,
      written: [...written, ...adopted.written],
    };
  }

  /**
   * Both adoption halves follow the same rule. Read the slot address, then let
   * `adoptionForSlot` decide everything else. `bytes` is for the pre-upload case, where the
   * hash is not in the store yet.
   */
  private async adoptPlan(
    hash: string,
    slot: string,
    replace: boolean,
    bytes?: Uint8Array,
  ): Promise<
    | { ok: false; code: string; reason: string }
    | { ok: true; project: LoadedProject; slot: RefBinding; plan: AdoptSlotPlan }
  > {
    const said = parseSlot(slot);
    if (!said) {
      return {
        ok    : false,
        code  : 'NOT_A_SLOT',
        reason: `"${slot}" is not a picture in this project. A slot reads like plate:cafe/night, sheet:aiko/gala/front or shot:greet/s2.`,
      };
    }
    const project = await loadProject(this.session.dir);
    const decided = await adoptionForSlot(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, slot: said, replace, ...(bytes ? { bytes } : {}) },
    );
    return decided.ok
      ? { ok: true, project, slot: said, plan: decided.plan }
      : { ok: false, code: decided.code, reason: decided.reason };
  }

  /** What `asset.adopt` would make this picture, without writing anything. */
  async previewAdopt(
    hash: string,
    slot: string,
    replace: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    const decided = await this.adoptPlan(hash, slot, replace);
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
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
  ): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
    const decided = await this.adoptPlan(hash, slot, replace);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const { project, slot: binding } = decided;
    const result = await adoptSlot(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, slot: binding, replace },
    );
    const superseded = result.plan.supersedes
      ? ` It supersedes the render ${result.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
      : '';
    return {
      ok     : true,
      message: `${hash.slice(0, 8)} is now the ${result.plan.label}.${superseded}`,
      hash   : result.ref.hash,
      written: this.adoptWrote(project, binding, result.plan),
    };
  }

  /**
   * The rule behind both replace halves: the asset names its own slot, so an author replacing
   * the picture in front of them never types one. Refusals come from {@link adoptionForSlot}
   * asked about these very bytes — a portrait, a concept and an upload are refused there by
   * name. Both the preview and the act ask the same question, so the strip on screen and the
   * command it runs apply the same rule.
   */
  private async replacePlan(
    hash: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; slot: RefBinding; note: string }> {
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    if (!info.slot) {
      return {
        ok    : false,
        reason: `${info.label} fills no slot — nothing planned it, or a later render took the slot over, so there is nothing for a file to replace.`,
      };
    }
    const slot = parseSlot(info.slot);
    if (!slot) return { ok: false, reason: `"${info.slot}" is not a picture in this project.` };

    // Apply every refusal except `MOCK_PLACEHOLDER`: that one judges the incoming bytes, and
    // the chooser has not produced any yet — `uploadOf` refuses mock art at the upload, which is
    // where that check belongs. This call only exists to check the slot itself.
    const decided = await this.adoptPlan(hash, info.slot, false);
    if (!decided.ok && decided.code !== 'MOCK_PLACEHOLDER') {
      return { ok: false, reason: decided.reason };
    }
    const label = decided.ok ? decided.plan.label : slotLabel(slot);
    return {
      ok: true,
      slot,
      note: `Opens a file chooser; what you choose becomes the ${label}, superseding ${hash.slice(0, 8)} — whose bytes stay in the store.`,
    };
  }

  /**
   * An older take goes back only where it was a take of a slot and a later render has taken that
   * slot over. Anything else has nothing to be put back into.
   *
   * The three kinds `previewAccept` refuses by name are refused here for the same reasons, and the
   * suspension and upstream-approval refusals are the ones accepting would give, because the whole
   * act ends in an accept.
   */
  private async restorePlan(
    hash: string,
  ): Promise<
    { ok: false; reason: string } | { ok: true; slot: string; newer: string; label: string }
  > {
    const info = await this.session.assetInfo(hash);
    if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
    if (info.kind === 'portrait') {
      const who = this.portraitOwner(info);
      const call = who ? `(characterId='${who}' hash='${hash}')` : '';
      return {
        ok    : false,
        reason: `${info.label} is a portrait; an earlier look goes back through gate.approve${call}.`,
      };
    }
    if (info.kind === 'concept' || info.kind === 'reference') {
      return {
        ok    : false,
        reason: `${info.label} is a ${info.kind}; nothing planned it, so it was never a take of anything.`,
      };
    }
    if (info.newerTake === undefined) {
      return {
        ok    : false,
        reason: info.slot
          ? `${info.label} is already the ${info.slot}.`
          : `${info.label} fills no slot, so there is nothing to put it back into.`,
      };
    }
    if (!info.drawnFor) {
      return { ok: false, reason: `${info.label} names no picture in this project any more.` };
    }
    if (info.suspended) {
      return {
        ok    : false,
        reason: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
      };
    }
    if (info.unapproved) return { ok: false, reason: info.unapproved };
    const decided = await this.adoptPlan(hash, info.drawnFor, true);
    if (!decided.ok) return { ok: false, reason: decided.reason };
    return { ok: true, slot: info.drawnFor, newer: info.newerTake, label: info.label };
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
    const project = await loadProject(this.session.dir);
    const asset = project.store.manifest().find((a) => a.hash === hash);
    if (!asset) return { ok: false, message: `No asset "${hash}" in the manifest.` };
    const bytes = await project.store.read({ hash: asset.hash, ext: asset.ext });
    await writeFile(file, bytes);
    return { ok: true, message: `Saved ${basename(file)}.`, file };
  }

  /** What `asset.restore` would put back, without writing it. */
  async previewRestore(hash: string): Promise<{ ok: boolean; message: string }> {
    const decided = await this.restorePlan(hash);
    if (!decided.ok) return { ok: false, message: decided.reason };
    return {
      ok     : true,
      message:
        `Would make ${decided.label} the ${decided.slot} again and accept it, superseding ` +
        `${decided.newer.slice(0, 8)} — whose bytes stay in the store, and whose prompt is then ` +
        'the one nothing is drawn from.',
    };
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
    const decided = await this.restorePlan(hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const project = await loadProject(this.session.dir);
    const slot = parseSlot(decided.slot);
    if (!slot)
      return {
        ok     : false,
        message: `"${decided.slot}" is not a picture in this project.`,
        written: [],
      };
    const result = await adoptSlot(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, slot, replace: true, keepPrompt: true },
    );
    const accepted = await this.session.acceptAsset(hash);
    if (!accepted.ok) return { ok: false, message: accepted.message, written: [] };
    return {
      ok     : true,
      message: `${decided.label} is the ${result.plan.label} again, and accepted. It supersedes ${decided.newer.slice(0, 8)}, whose bytes stay in the store.`,
      written: this.adoptWrote(project, slot, result.plan),
    };
  }

  /** What `asset.replace` would replace, before the chooser is opened. */
  async previewReplace(hash: string): Promise<{ ok: boolean; message: string }> {
    const decided = await this.replacePlan(hash);
    return decided.ok
      ? { ok: true, message: decided.note }
      : { ok: false, message: decided.reason };
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
    const decided = await this.replacePlan(hash);
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    return this.session.uploadAsset(file, '', slotKey(decided.slot), true);
  }

  /** What an adoption touched: the manifest its kind routes to, the log, and a shot's own file. */
  private adoptWrote(project: LoadedProject, slot: RefBinding, plan: AdoptSlotPlan): string[] {
    const manifest =
      plan.kind === 'shot_image' ? project.paths.manifest : project.paths.baseManifest;
    return [
      ...(slot.kind === 'shot'
        ? [relPath(this.session.dir, project.paths.shotsFile(slot.sceneId))]
        : []),
      relPath(this.session.dir, manifest),
      relPath(this.session.dir, project.paths.tasksLog),
    ];
  }

  /** What `art.redraw` would draw, decided from the manifest without spending the call. */
  async previewRedraw(
    hash: string,
    prompt: string,
    title: string,
  ): Promise<{ ok: boolean; message: string }> {
    const project = await loadProject(this.session.dir);
    const decided = redrawOf(
      project.store,
      { hash, prompt, title },
      { seeded: this.seeded(project) },
    );
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
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
    const project = await loadProject(this.session.dir);
    const decided = redrawOf(
      project.store,
      { hash, prompt, title },
      { seeded: this.seeded(project) },
    );
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const result = await this.session.while('a concept image', async () => {
      const providers = await buildProviders(project, this.session.mock);
      return redrawConcept(
        {
          config: project.config,
          model : project.model,
          store : project.store,
          image : providers.image,
        },
        { hash, prompt, title },
      );
    });
    const same = result.unchanged
      ? ' The same prompt and a fixed seed gave back the same picture, so nothing new was written.'
      : ` ${hash.slice(0, 8)} is still there.`;
    return {
      ok     : true,
      message: `Redrew ${hash.slice(0, 8)} as ${result.ref.hash.slice(0, 8)}.${same}`,
      hash   : result.ref.hash,
      written: [
        relPath(this.session.dir, result.file),
        relPath(this.session.dir, project.paths.baseManifest),
      ],
    };
  }

  /** Whether a re-roll would come back identical — one fixed seed, one prompt, one picture. */
  private seeded(project: LoadedProject): boolean {
    return project.config.image_params.seed !== undefined;
  }

  /** What `art.promote` would do, decided from the manifest without writing anything. */
  async previewPromote(hash: string, variant: string): Promise<{ ok: boolean; message: string }> {
    const project = await loadProject(this.session.dir);
    const decided = promotionOf(project.store, { hash, variant });
    return decided.ok
      ? { ok: true, message: decided.plan.note }
      : { ok: false, message: decided.reason };
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
    const project = await loadProject(this.session.dir);
    const decided = promotionOf(project.store, { hash, variant });
    if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
    const result = await promoteConcept(
      { config: project.config, paths: project.paths, store: project.store },
      { hash, variant, ...(description.trim() ? { description: description.trim() } : {}) },
    );
    const added = result.addedVariant ? ` "${result.variant}" is new on its sheet.` : '';
    return {
      ok     : true,
      message: `Promoted ${hash.slice(0, 8)} to the ${result.variant} plate for ${result.locationId}.${added}`,
      written: [
        ...(result.file ? [relPath(this.session.dir, result.file)] : []),
        relPath(this.session.dir, project.paths.baseManifest),
        relPath(this.session.dir, project.paths.tasksLog),
      ],
    };
  }

  /**
   * The sidebar's logical tree plus per-entity backlinks. One load, one manifest, one storyboard
   * read per scene — which is exactly why this is not folded into `workspace:index`, the shape
   * the agent refetches every turn.
   */
}
