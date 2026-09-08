/**
 * What the Skills pane decides before it draws: which skill a path belongs to, and the sentence the
 * "ask the agent" button hands to the agent form.
 *
 * This module is pure because the desktop jest project is node-only and the pane itself can only
 * be checked live over CDP, so everything that is a rule rather than markup is tested here
 * instead. `assetview.ts` sits alongside it for the same reason.
 *
 * `SKILLS_DIR` and `underSkills` are re-exported rather than defined: the Skills claim in
 * `src/shared/editors.ts` needs the same predicate, and one directory must not have two spellings
 * in one app. Everything this pane compares against came off the wire forward-slashed, which is
 * why neither of them is `@vn/authoring`'s `PROJECT_SKILLS_DIR`.
 */
export { SKILLS_DIR, underSkills } from '../../src/shared/editors.js';

import type { Offer } from './anchors.js';
import { saveOffer } from './docbuffer.js';
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
 * send it. The agent's instructions live in the tool's description rather than in this string,
 * which is the author's first sentence and is editable.
 */
export const NEW_SKILL_PROMPT =
  'Write a new skill under .aiagent/skills — a SKILL.md with name, description and when-to-use ' +
  'in its front-matter, and the procedure below it. It should: ';

/** What the Skills pane reads when it draws its bar and its hint. */
export interface SkillsState {
  /** The open skill file's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
}

/**
 * The hint's door to the agent: opens the agent form with `NEW_SKILL_PROMPT` already typed, so
 * the author finishes the sentence rather than sending it. `agent.run` is mutating and plan-first,
 * so the click opens the form instead of running anything.
 */
export function askSkillAction(): Offer {
  return {
    ok     : true,
    id     : 'agent.run',
    props  : { input: NEW_SKILL_PROMPT },
    label  : 'Ask the agent for a skill…',
    tooltip: 'Open the agent form with a request for a new skill — you say what it should do',
    form   : true,
  };
}

/** Every offer the Skills pane draws from this module. */
export function controls(state: SkillsState): readonly Offer[] {
  return [saveOffer(state.path, state.dirty), askSkillAction()];
}
