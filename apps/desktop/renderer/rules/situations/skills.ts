/** The Skills pane's situations: whether a skill file is open, from which tier, and whether it has changed. */
import { situations } from './situation.js';
import type { SkillsState } from '../skills.js';

export const SITUATIONS = situations<SkillsState>(
  {
    name : 'none-open',
    why: 'No skill is open, so Save and the text box are refused; reload and the hint’s agent button are always offered.',
    state: { path: '', dirty: false },
  },
  {
    name : 'open',
    why  : 'A skill is open and unchanged, so Save is refused with Nothing to save.',
    state: { path: '.aiagent/skills/casting/SKILL.md', dirty: false },
  },
  {
    name : 'open-dirty',
    why  : 'The open skill has changed, so Save is offered.',
    state: { path: '.aiagent/skills/casting/SKILL.md', dirty: true },
  },
  {
    name : 'builtin-open',
    why: 'A builtin skill is open, so Save and the box are refused as read-only, Clone into project and Clone into user folder are both offered.',
    state: { path: '<builtin>/branching/SKILL.md', dirty: false },
  },
  {
    name : 'user-open',
    why: 'A user skill is open, so Save and the box are refused as read-only, Clone into project is offered and Clone into user folder is refused as already there.',
    state: { path: '<user>/skills/casting/SKILL.md', dirty: false },
  },
);
