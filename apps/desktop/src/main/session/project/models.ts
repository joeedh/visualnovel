import {
  CONFIG_FILENAME,
  keyStatus,
  missingRouteError,
  secretDirsFor,
  setImageModel,
  setTextModel,
  setVisionModels,
} from '@vn/config';
import { join } from 'node:path';
import { chatVendorFor, imageVendorOf } from '@vn/providers';
import { chatRouteFor, imageRouteFor, type KeysPresent, type ProjectConfig } from '@vn/types';
import type { WorkspaceSession } from '../core.js';
import { loadProject } from '../load/project.js';
import type { PromptResult, PromptWriteResult } from '../types/results.js';
import { IMAGE_KINDS } from '../rules/assets.js';
import { relPath } from '../load/tree.js';

/** Which keys resolve, as the route tables read them. */
async function keysPresent(session: WorkspaceSession, config: ProjectConfig): Promise<KeysPresent> {
  const status = await keyStatus(config, { secretsDirs: await secretDirsFor(session.dir) });
  return Object.fromEntries(status.map((s) => [s.vendor, s.resolved])) as unknown as KeysPresent;
}

/**
 * What `project.setImageModel` would do, without writing it. A model whose vendor has no key is
 * refused here rather than at the first task that would draw with it. The count is of the
 * image tasks still to draw, which are the ones the new model reaches: the model is not in a
 * task's hash, so a rendered one keeps its picture.
 */
export async function previewImageModel(
  session: WorkspaceSession,
  modelId: string,
): Promise<PromptResult> {
  const id = modelId.trim();
  if (!id) return { ok: false, message: 'No image model given.' };

  const project = await loadProject(session.dir);
  if (project.config.models.image === id) {
    return { ok: false, message: 'The project already says that.' };
  }

  if (imageRouteFor(id, await keysPresent(session, project.config)) === undefined) {
    const refusal = missingRouteError(project.config, id, imageVendorOf(id));
    return { ok: false, message: `${refusal.message}; provide one in Setup first` };
  }

  const count = project.graph
    .all()
    .filter((task) => IMAGE_KINDS.has(task.kind) && task.status !== 'done').length;
  return {
    ok     : true,
    message: `Set the image model to \`${id}\`. Pictures already drawn stay; ${count} image task(s) still to draw, and anything regenerated, will use it.`,
  };
}

/** Write the project's image model, spliced into `project.yaml`'s `models:` block. */
export async function setProjectImageModel(
  session: WorkspaceSession,
  modelId: string,
): Promise<PromptWriteResult> {
  const preview = await session.previewImageModel(modelId);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setImageModel(session.dir, modelId.trim()))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/**
 * What `project.setTextModel` would do, without writing it. A model no resolved key can carry
 * is refused here rather than at the first pipeline call that would use it. The pipeline's
 * text calls read the key on their next run; the agent's own model is chosen per conversation
 * and is not this setting.
 */
export async function previewTextModel(
  session: WorkspaceSession,
  modelId: string,
): Promise<PromptResult> {
  const id = modelId.trim();
  if (!id) return { ok: false, message: 'No text model given.' };
  const project = await loadProject(session.dir);
  if (project.config.models.text === id) {
    return { ok: false, message: 'The project already says that.' };
  }
  if (chatRouteFor(id, await keysPresent(session, project.config)) === undefined) {
    const refusal = missingRouteError(project.config, id, chatVendorFor(id));
    return { ok: false, message: `${refusal.message}; provide one in Setup first` };
  }
  return {
    ok     : true,
    message: `Set the text model to \`${id}\`. The pipeline's text calls — decomposition, reviews, refine critiques — use it from the next run.`,
  };
}

/** Write the project's text model, spliced into `project.yaml`'s `models:` block. */
export async function setProjectTextModel(
  session: WorkspaceSession,
  modelId: string,
): Promise<PromptWriteResult> {
  const preview = await previewTextModel(session, modelId);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setTextModel(session.dir, modelId.trim()))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/**
 * What `project.setVisionModels` would do, without writing it. The list is the whole set of
 * reviewers, in order; an empty list is refused because a run with no reviewer cannot judge a
 * picture, and a model no key can carry is refused by name.
 */
export async function previewVisionModels(
  session: WorkspaceSession,
  modelIds: readonly string[],
): Promise<PromptResult> {
  const ids = modelIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, message: 'At least one vision model is needed.' };
  const project = await loadProject(session.dir);
  const before = project.config.models.vision;
  if (before.length === ids.length && before.every((id, i) => id === ids[i])) {
    return { ok: false, message: 'The project already says that.' };
  }
  const present = await keysPresent(session, project.config);
  const unrouted = ids.find((id) => chatRouteFor(id, present) === undefined);
  if (unrouted !== undefined) {
    const refusal = missingRouteError(project.config, unrouted, chatVendorFor(unrouted));
    return { ok: false, message: `${refusal.message}; provide one in Setup first` };
  }
  return {
    ok     : true,
    message: `Set the vision models to ${ids.map((id) => `\`${id}\``).join(', ')}. The next run's picture reviews use them.`,
  };
}

/** Write the project's vision reviewers, spliced into `project.yaml`'s `models:` block. */
export async function setProjectVisionModels(
  session: WorkspaceSession,
  modelIds: readonly string[],
): Promise<PromptWriteResult> {
  const preview = await previewVisionModels(session, modelIds);
  if (!preview.ok) return { ...preview, written: [] };
  const ids = modelIds.map((id) => id.trim()).filter(Boolean);
  if (!(await setVisionModels(session.dir, ids))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}
