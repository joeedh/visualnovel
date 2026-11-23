import {
  CONFIG_FILENAME,
  setArtStyle,
  setBubbleNames,
  setLettering,
  setShotForm,
  setStoryboardNotes,
} from '@vn/config';
import { join } from 'node:path';
import type { Lettering, ShotForm } from '@vn/types';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject, withShots } from '../load/project.js';
import type { PromptResult, PromptWriteResult } from '../types/results.js';
import { IMAGE_KINDS } from '../rules/assets.js';
import { relPath } from '../load/tree.js';

/**
 * How many of a project's shots are pages, which is what a change of lettering re-keys. A
 * storyboard that will not parse counts for nothing here, since its pages cannot render either.
 */
async function pageShotCount(project: LoadedProject): Promise<number> {
  let pages = 0;
  for (const board of (await withShots(project)).production.values()) {
    for (const shot of board.shots) if (shot.panels) pages += 1;
  }
  return pages;
}

/** What `project.setArtStyle` would do, without writing it. */
export async function previewArtStyle(
  session: WorkspaceSession,
  style: string,
): Promise<PromptResult> {
  const project = await loadProject(session.dir);
  if (project.config.art_style === style) {
    return { ok: false, message: 'The project already says that.' };
  }
  const count = project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length;
  const said = style.trim() ? `Set the art style to "${style.trim()}".` : 'Clear the art style.';
  return {
    ok     : true,
    message: `${said} It opens every image prompt, so it re-keys ${count} image task(s).`,
  };
}

/**
 * Write the project's art style. It is spliced into `project.yaml` rather than re-serialized,
 * so an author's comments and key order survive — the same posture the prose writers take with
 * front-matter.
 */
export async function setProjectArtStyle(
  session: WorkspaceSession,
  style: string,
): Promise<PromptWriteResult> {
  const preview = await session.previewArtStyle(style);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setArtStyle(session.dir, style))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/** What `project.setStoryboardNotes` would do, without writing it. */
export async function previewStoryboardNotes(
  session: WorkspaceSession,
  notes: string,
): Promise<PromptResult> {
  const project = await loadProject(session.dir);
  if (project.config.storyboard_notes === notes) {
    return { ok: false, message: 'The project already says that.' };
  }
  const said = notes.trim()
    ? `Set the storyboard notes to "${notes.trim()}".`
    : 'Clear the storyboard notes.';
  return {
    ok     : true,
    message:
      `${said} The decomposer reads them the next time a scene is storyboarded; no shot ` +
      'already written is re-keyed.',
  };
}

/** Write the decomposer's directives, spliced into `project.yaml` like the art style. */
export async function setProjectStoryboardNotes(
  session: WorkspaceSession,
  notes: string,
): Promise<PromptWriteResult> {
  const preview = await session.previewStoryboardNotes(notes);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setStoryboardNotes(session.dir, notes))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/**
 * What `project.setLettering` would do, without writing it. Lettering is in a page shot's
 * prompt and nowhere else, so the price is the page shots the project holds.
 */
export async function previewLettering(
  session: WorkspaceSession,
  lettering: Lettering,
): Promise<PromptResult> {
  const project = await loadProject(session.dir);
  if (project.config.lettering === lettering) {
    return { ok: false, message: 'The project already says that.' };
  }
  const pages = await pageShotCount(project);
  return {
    ok     : true,
    message:
      `Set lettering to "${lettering}". It applies to page shots alone, so it re-keys ` +
      `${pages} of them.`,
  };
}

/** Write who letters a page shot, spliced into `project.yaml` like the art style. */
export async function setProjectLettering(
  session: WorkspaceSession,
  lettering: Lettering,
): Promise<PromptWriteResult> {
  const preview = await session.previewLettering(lettering);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setLettering(session.dir, lettering))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/** What `project.setShotForm` would do, without writing it. */
export async function previewShotForm(
  session: WorkspaceSession,
  form: ShotForm,
): Promise<PromptResult> {
  const project = await loadProject(session.dir);
  if (project.config.shot_form === form) {
    return { ok: false, message: 'The project already says that.' };
  }
  return {
    ok     : true,
    message:
      form === 'pages'
        ? 'Storyboard new scenes as manga pages of panels. A storyboard already written keeps its shape.'
        : 'Storyboard new scenes as single frames. A storyboard already written keeps its shape.',
  };
}

/** Write what a shot is, spliced into `project.yaml` like the art style. */
export async function setProjectShotForm(
  session: WorkspaceSession,
  form: ShotForm,
): Promise<PromptWriteResult> {
  const preview = await session.previewShotForm(form);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setShotForm(session.dir, form))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}

/** What `project.setBubbleNames` would do, without writing it. */
export async function previewBubbleNames(
  session: WorkspaceSession,
  on: boolean,
): Promise<PromptResult> {
  const project = await loadProject(session.dir);
  if (project.config.bubble_names === on) {
    return { ok: false, message: 'The project already says that.' };
  }
  return {
    ok     : true,
    message: on
      ? "Show the speaker's name in every speech bubble the runner draws, except where a " +
        'bubble says otherwise. Nothing is drawn again.'
      : "Leave the speaker's name out of the bubbles the runner draws, except where a bubble " +
        'says otherwise. Nothing is drawn again.',
  };
}

/** Write whether bubbles name their speaker, spliced into `project.yaml` like the art style. */
export async function setProjectBubbleNames(
  session: WorkspaceSession,
  on: boolean,
): Promise<PromptWriteResult> {
  const preview = await session.previewBubbleNames(on);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setBubbleNames(session.dir, on))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}
