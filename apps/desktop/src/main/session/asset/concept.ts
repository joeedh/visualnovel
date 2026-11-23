import { baseRefusal } from '@vn/constraint-solver';
import {
  generateConcept,
  promoteConcept,
  promotionOf,
  redrawConcept,
  redrawOf,
  type ConceptRequest,
} from '@vn/artgen';
import { formatSubject, matchSubject, parseSubject, subjectEntity } from '@vn/stills';
import type { WorkspaceSession } from '../core.js';
import { buildProviders } from '../gen/deps.js';
import { type LoadedProject, loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';

/**
 * The composed prompt for one asset: the chunks the builders derived, what the author's override
 * does to them, and the one string that would be sent. `null` when the manifest has never heard
 * of the hash.
 *
 * The pane reads this off `assetInfo`, so a picture and its prompt are one round trip; the
 * command is the same projection for an agent and for CDP.
 */
async function conceptPlan(
  session: WorkspaceSession,
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
  const project = await loadProject(session.dir);
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
export async function previewConcept(
  session: WorkspaceSession,
  sentence: string,
  subject: string,
): Promise<{ ok: boolean; message: string }> {
  const decided = await conceptPlan(session, sentence, subject);
  return decided.ok ? { ok: true, message: decided.note } : { ok: false, message: decided.reason };
}

/**
 * Draw one concept image: a sentence in, an asset out, with no task node and no place in any
 * plan — the one path to an image the planner deliberately does not have. Providers come from
 * the session's own `mock` flag, so there is no second policy about whether this run makes
 * real art.
 */
export async function drawConcept(
  session: WorkspaceSession,
  sentence: string,
  subject: string,
): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
  const decided = await conceptPlan(session, sentence, subject);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const { project, req } = decided;
  const result = await session.while('a concept image', async () => {
    const providers = await buildProviders(project, session.mock);
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
    written: [relPath(session.dir, result.file), relPath(session.dir, project.paths.baseManifest)],
  };
}

/** What `art.redraw` would draw, decided from the manifest without spending the call. */
export async function previewRedraw(
  session: WorkspaceSession,
  hash: string,
  prompt: string,
  title: string,
): Promise<{ ok: boolean; message: string }> {
  const project = await loadProject(session.dir);
  const decided = redrawOf(project.store, { hash, prompt, title }, { seeded: seeded(project) });
  return decided.ok
    ? { ok: true, message: decided.plan.note }
    : { ok: false, message: decided.reason };
}

/**
 * Draw a concept again, from an edited prompt or the same one. A concept is the one asset whose
 * prompt is authored rather than derived, so it is the one asset an author can rewrite; the
 * result is a new sketch beside the old one, because bytes are content-addressed.
 */
export async function redrawAsset(
  session: WorkspaceSession,
  hash: string,
  prompt: string,
  title: string,
): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
  const project = await loadProject(session.dir);
  const decided = redrawOf(project.store, { hash, prompt, title }, { seeded: seeded(project) });
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const result = await session.while('a concept image', async () => {
    const providers = await buildProviders(project, session.mock);
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
    written: [relPath(session.dir, result.file), relPath(session.dir, project.paths.baseManifest)],
  };
}

/** Whether a re-roll would come back identical — one fixed seed, one prompt, one picture. */
function seeded(project: LoadedProject): boolean {
  return project.config.image_params.seed !== undefined;
}

/** What `art.promote` would do, decided from the manifest without writing anything. */
export async function previewPromote(
  session: WorkspaceSession,
  hash: string,
  variant: string,
): Promise<{ ok: boolean; message: string }> {
  const project = await loadProject(session.dir);
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
export async function promoteAsset(
  session: WorkspaceSession,
  hash: string,
  variant: string,
  description: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const project = await loadProject(session.dir);
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
      ...(result.file ? [relPath(session.dir, result.file)] : []),
      relPath(session.dir, project.paths.baseManifest),
      relPath(session.dir, project.paths.tasksLog),
    ],
  };
}
