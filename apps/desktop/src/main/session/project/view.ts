import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import {
  createMockProviders,
  listOpenRouterImageModels,
  listTextModels,
  type FetchImpl,
  type OpenRouterListing,
} from '@vn/providers';
import { shippedImageModels } from '@vn/gengraph';
import { readModelCatalog, validateProject, writeModelCatalog } from '@vn/gengraph/state';
import type { ProjectFinding } from '@vn/artgen';
import type { TextLLM } from '@vn/types';
import type { ProjectView } from '../../../shared/ipc.js';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject, readProject } from '../load/project.js';
import { IMAGE_KINDS } from '../rules/assets.js';
import { buildProviders } from '../gen/deps.js';
import { builtinSkills } from './skills.js';

/** Lists every reference that would fail a run or a read, from a read that repairs nothing. */
export async function validate(session: WorkspaceSession): Promise<ProjectFinding[]> {
  const { model } = await readProject(session.dir);
  return validateProject({ root: session.dir, model });
}

export async function projectView(session: WorkspaceSession): Promise<ProjectView> {
  const project = await loadProject(session.dir);
  const { config } = project;
  const cached = await readModelCatalog();
  return {
    root         : session.dir,
    title        : config.title,
    artStyle     : config.art_style,
    start        : config.start ?? '',
    models       : { ...config.models },
    imageParams  : { ...config.image_params },
    bubbleNames  : config.bubble_names,
    shotForm     : config.shot_form,
    imageTasks   : project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length,
    imageModels: {
      shipped   : shippedImageModels(),
      openrouter: cached?.openrouter ?? [],
      default   : config.models.image,
      text      : cached?.text ?? [],
      ...(cached === undefined ? {} : { asOf: cached.asOf }),
    },
    builtinSkills: await builtinSkills(session),
  };
}

/**
 * Fetches OpenRouter's image-model listing and the text-model listings, and replaces the cached
 * file. The image listing is the part that has to succeed: when it fails the file is left as it
 * was and the reason comes back. Anthropic and Gemini are asked for their text models only
 * when a key for them resolves; a text vendor that is skipped or fails is named in the message
 * and the others still land. A model whose endpoints call failed is written without a price
 * and counted in the message.
 */
export async function refreshModelCatalog(
  session: WorkspaceSession,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: true; message: string; listed: number } | { ok: false; reason: string }> {
  let listing: OpenRouterListing;
  try {
    listing = await listOpenRouterImageModels(fetchImpl);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const keys = await resolveKeys(await loadConfig(session.dir), {
    secretsDirs: await secretDirsFor(session.dir),
  });
  const text = await listTextModels(
    {
      ...(keys.anthropic ? { anthropic: keys.anthropic } : {}),
      ...(keys.gemini ? { gemini: keys.gemini } : {}),
    },
    fetchImpl,
  );
  const asOf = new Date().toISOString().slice(0, 10);
  await writeModelCatalog({ asOf, openrouter: listing.models, text: text.models });

  const priced = listing.models.filter((entry) => entry.priceUsd !== undefined).length;
  const failed =
    listing.unpriced.length === 0
      ? ''
      : `; ${listing.unpriced.length} endpoints call(s) failed, so those are listed unpriced`;
  const textNotes = [
    ...text.skipped.map((vendor) => `${vendor} was not asked, since no key for it resolved`),
    ...text.failed.map((f) => `${f.vendor}'s listing failed: ${f.reason}`),
  ];
  const textSaid =
    ` Listed ${text.models.length} text model(s)` +
    (textNotes.length === 0 ? '.' : ` (${textNotes.join('; ')}).`);
  return {
    ok     : true,
    listed : listing.models.length + text.models.length,
    message:
      `Listed ${listing.models.length} OpenRouter image model(s) as of ${asOf}, ` +
      `${priced} with a per-picture price${failed}.${textSaid}`,
  };
}

/**
 * The text provider a condensation runs against. Under `--mock` the backend echoes the prompt,
 * which no schema accepts, so every condensation would take the deterministic fallback and the
 * real path would never run; the canned answer is the identity condensation, which exercises it
 * with the chunks' own words.
 */
export function condensingText(
  session: WorkspaceSession,
  project: LoadedProject,
  flat: string,
): Promise<TextLLM> {
  if (!session.mock) return buildProviders(project, false).then((p) => p.text);
  return Promise.resolve(
    createMockProviders({ textResponses: [JSON.stringify({ prompt: flat, omitted: [] })] }).text,
  );
}
