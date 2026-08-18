/**
 * What the Skills pane decides before it draws: which skill a path belongs to, and the sentence the
 * "ask the agent" button hands to the agent form.
 *
 * Pure, because the desktop jest project is node-only and the pane itself can only be checked live
 * over CDP — so everything that is a *rule* rather than markup is tested here instead, beside
 * `assetview.ts` for the same reason.
 *
 * `SKILLS_DIR` and `underSkills` are re-exported rather than defined: the Skills **claim** in
 * `src/shared/editors.ts` needs the same predicate, and one directory must not have two spellings
 * in one app. Everything this pane compares against came off the wire forward-slashed, which is
 * why neither of them is `@vn/authoring`'s `PROJECT_SKILLS_DIR`.
 */
export { SKILLS_DIR, underSkills } from '../../src/shared/editors.js';

import { SKILLS_DIR, underSkills } from '../../src/shared/editors.js';

/**
 * Which skill a path belongs to — `.aiagent/skills/continuity-pass/SKILL.md` → `continuity-pass`.
 * `''` for anything outside, including the skills directory itself: the directory is not a skill,
 * and a caller that treated `''` as one would open a pane on nothing.
 */
export function skillIdOf(path: string | undefined): string {
  if (!underSkills(path)) return '';
  const rest = (path as string).slice(SKILLS_DIR.length + 1);
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.slice(0, slash);
}

/**
 * What the pane's button puts in the agent form. It ends mid-sentence on purpose — the form opens
 * on a blank the author finishes, rather than on a turn that is already a complete request for
 * something nobody asked for.
 *
 * It names the directory and the three front-matter keys because the agent's own `create_skill`
 * writes them, and an author reading the form should see what they are about to get before they
 * send it. Nothing here is the agent's instructions — those are the tool's description; this is
 * the human's first sentence, and it is editable.
 */
export const NEW_SKILL_PROMPT =
  'Write a new skill under .aiagent/skills — a SKILL.md with name, description and when-to-use ' +
  'in its front-matter, and the procedure below it. It should: ';
