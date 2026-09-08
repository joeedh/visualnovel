/** The Skills pane's situations: whether a skill file is open, and whether it has changed. */
import { situations } from './situation.js';
import type { SkillsState } from '../skills.js';

export const SITUATIONS = situations<SkillsState>(
  {
    name : 'none-open',
    why  : 'No skill is open, so Save is refused; the hint’s agent button is always offered.',
    state: { path: '', dirty: false },
  },
  {
    name : 'open',
    why  : 'A skill is open and unchanged, so Save is refused with Nothing to save.',
    state: { path: '.vnauthor/skills/casting/SKILL.md', dirty: false },
  },
  {
    name : 'open-dirty',
    why  : 'The open skill has changed, so Save is offered.',
    state: { path: '.vnauthor/skills/casting/SKILL.md', dirty: true },
  },
);
