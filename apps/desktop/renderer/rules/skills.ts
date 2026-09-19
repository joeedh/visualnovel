/**
 * What the Skills pane decides before it draws: which skill and which tier a path belongs to, what
 * Save and the two Clone buttons offer for it, and the sentence the "ask the agent" button hands
 * to the agent form.
 *
 * This module is pure because the desktop jest project is node-only and the pane itself can only
 * be checked live over CDP, so everything that is a rule rather than markup is tested here
 * instead. `assetview.ts` sits alongside it for the same reason.
 *
 * `SKILLS_DIR`, `underSkills` and `skillTierOf` are re-exported rather than defined: the Skills
 * claim in `src/shared/editors.ts` needs the same predicates, and one directory must not have two
 * spellings in one app. Everything this pane compares against came off the wire forward-slashed,
 * which is why none of them is `@vn/authoring`'s `PROJECT_SKILLS_DIR`.
 */
export {
  SKILLS_DIR,
  SKILL_TIER_LABELS,
  skillTierOf,
  underSkills,
  type SkillTier,
} from '../../src/shared/editors.js';

import { refuse, type Offer } from './anchors.js';
import { reloadOffer, saveOffer, textBox } from './docbuffer.js';
import {
  skillTierOf,
  skillTierPath,
  underSkills,
  type SkillTier,
} from '../../src/shared/editors.js';

/**
 * Which skill a path belongs to — `.aiagent/skills/continuity-pass/SKILL.md` → `continuity-pass`,
 * and `<builtin>/branching/SKILL.md` → `branching`. `''` for anything outside, including a tier's
 * directory itself: the directory is not a skill, and a caller that treated `''` as one would open
 * a pane on nothing.
 */
export function skillIdOf(path: string | undefined): string {
  if (!underSkills(path)) return '';
  const rest = skillTierPath(path as string)!.rest;
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.slice(0, slash);
}

/**
 * Why the open file cannot be saved from here, or `''` for a project skill. A builtin skill ships
 * with the app and a user skill is shared across projects; both are edited as a copy, and the
 * sentence names the button that makes one.
 */
export function readOnlyReason(path: string): string {
  switch (skillTierOf(path)) {
    case 'builtin':
      return 'This is a builtin skill and is read-only. Clone it to edit a copy.';
    case 'user':
      return 'This is a user skill, shared across projects, and is edited in its own folder. Clone it into the project to edit a copy here.';
    default:
      return '';
  }
}

/**
 * The bar's Save, which for a user or builtin skill is refused with the reason it is read-only
 * rather than with Nothing to save — the box never becomes dirty, and a control that said
 * "nothing to save" over a file that cannot be saved would be answering the wrong question.
 */
export function skillSaveOffer(path: string, dirty: boolean): Offer {
  const reason = path === '' ? '' : readOnlyReason(path);
  if (!reason) return saveOffer(path, dirty);
  const plain = saveOffer('', false);
  return { ...plain, ...refuse(reason) };
}

/** What each Clone button says, refused with why when the open skill is already in that tier. */
export function cloneOffer(path: string, into: 'project' | 'user'): Offer {
  const id = skillIdOf(path);
  const tier = skillTierOf(path);
  const control =
    into === 'project'
      ? {
          id     : 'skill.cloneToProject',
          label  : 'Clone into project',
          tooltip:
            'Copy this skill into this project’s .aiagent/skills so you can edit it — the ' +
            'original is unaffected either way',
        }
      : {
          id     : 'skill.cloneToUser',
          label  : 'Clone into user folder',
          tooltip:
            'Copy this skill into your own skills folder, where every project on this machine ' +
            'can use it — the original is unaffected either way',
        };
  if (id === '' || tier === undefined) return { ...refuse('No skill is open.'), ...control };
  if (tier === into) {
    return { ...refuse(`This is already a ${ALREADY[into]}.`), ...control };
  }
  return { ok: true, props: { id }, ...control };
}

const ALREADY: Record<'project' | 'user', string> = {
  project: 'project skill',
  user   : 'user skill',
};

/**
 * The badge under the box for a skill from outside the project, or `''` for a project skill and
 * for nothing open. A project skill is the ordinary case and carries no badge, the same way the
 * document tree badges only what came from elsewhere.
 */
export function tierBadge(path: string): string {
  const tier: SkillTier | undefined = skillTierOf(path);
  return tier === undefined || tier === 'project' ? '' : tier;
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
  return [
    skillSaveOffer(state.path, state.dirty),
    reloadOffer(RELOAD_TIP),
    cloneOffer(state.path, 'project'),
    cloneOffer(state.path, 'user'),
    askSkillAction(),
    skillTextBox(state.path),
  ];
}

/**
 * The text box: the same write Save is, for a project skill, and refused with the read-only
 * reason for a user or builtin one, whose box shows the file without taking an edit.
 */
export function skillTextBox(path: string): Offer {
  const reason = path === '' ? '' : readOnlyReason(path);
  if (!reason) return textBox(path, TEXT_TIP);
  return { ...textBox('', READ_TIP), ...refuse(reason) };
}

export const TEXT_TIP = 'Edit this file as text. Ctrl+S saves and commits.';
export const READ_TIP = 'The file, as text. Read-only here.';
export const RELOAD_TIP = 'Re-read this file from disk (discards an unsaved draft)';
