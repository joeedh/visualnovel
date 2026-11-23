import { CONFIG_FILENAME, setBuiltinSkills } from '@vn/config';
import { join } from 'node:path';
import { discoverSkills, skillRoots } from '@vn/authoring';
import type { BuiltinSkillView } from '../../../shared/ipc.js';
import { builtinSkillsDir } from '../../distribution/resources.js';
import type { WorkspaceSession } from '../core.js';
import { relPath } from '../load/tree.js';
import type { PromptResult, PromptWriteResult } from '../types/results.js';

/**
 * The builtin catalog as this project sees it: every shipped skill, on or off. Read from the
 * catalog root alone rather than through the three-tier roots, so a project skill that shadows
 * a builtin one still leaves the builtin one listed here — the checkbox is about the catalog,
 * not about which copy the agent would run.
 */
export async function builtinSkills(session: WorkspaceSession): Promise<BuiltinSkillView[]> {
  const roots = await skillRoots(session.dir, { builtinDir: builtinSkillsDir() });
  const builtin = roots.filter((root) => root.tier === 'builtin');
  const skills = await discoverSkills(builtin, { keepDisabled: true });
  return skills.map((skill) => ({
    id         : skill.id,
    name       : skill.name,
    description: skill.description,
    enabled    : skill.enabled,
  }));
}

/**
 * What `project.setBuiltinSkills` would do, without writing it. The list is compared as a set:
 * the order in the file is the order the author last ticked things in, and re-saving it in
 * another order is not a change.
 */
export async function previewBuiltinSkills(
  session: WorkspaceSession,
  ids: readonly string[],
): Promise<PromptResult> {
  const catalog = await builtinSkills(session);
  const known = new Set(catalog.map((skill) => skill.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return { ok: false, message: `Not a builtin skill: ${unknown.join(', ')}.` };
  }
  const wanted = new Set(ids);
  const before = new Set(catalog.filter((skill) => skill.enabled).map((skill) => skill.id));
  const turnedOn = catalog.filter((s) => wanted.has(s.id) && !before.has(s.id)).map((s) => s.id);
  const turnedOff = catalog.filter((s) => before.has(s.id) && !wanted.has(s.id)).map((s) => s.id);
  if (turnedOn.length === 0 && turnedOff.length === 0) {
    return { ok: false, message: 'The project already says that.' };
  }
  const parts = [
    turnedOn.length > 0 ? `turns on ${turnedOn.join(', ')}` : '',
    turnedOff.length > 0 ? `turns off ${turnedOff.join(', ')}` : '',
  ].filter(Boolean);
  return {
    ok     : true,
    message: `This ${parts.join(' and ')}. The agent sees a builtin skill only while it is on.`,
  };
}

/**
 * Write which builtin skills the project enables, spliced into `project.yaml` like the art
 * style. Ids the catalog does not have are refused here rather than dropped, since a checkbox
 * cannot send one and the palette should hear about a typo.
 */
export async function setProjectBuiltinSkills(
  session: WorkspaceSession,
  ids: readonly string[],
): Promise<PromptWriteResult> {
  const preview = await previewBuiltinSkills(session, ids);
  if (!preview.ok) return { ...preview, written: [] };
  if (!(await setBuiltinSkills(session.dir, ids))) {
    return { ok: false, message: 'The project already says that.', written: [] };
  }
  return {
    ok     : true,
    message: preview.message,
    written: [relPath(session.dir, join(session.dir, CONFIG_FILENAME))],
  };
}
