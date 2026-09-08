import {
  NEW_SKILL_PROMPT,
  SKILLS_DIR,
  askSkillAction,
  controls,
  skillIdOf,
  underSkills,
  type SkillsState,
} from '../skills.js';
import { saveOffer } from '../docbuffer.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('underSkills', () => {
  it('is true for a file inside a skill', () => {
    expect(underSkills('.aiagent/skills/continuity-pass/SKILL.md')).toBe(true);
    expect(underSkills('.aiagent/skills/lint-fountain/run.mjs')).toBe(true);
  });

  it('is false for everything outside', () => {
    expect(underSkills('wiki/lore.md')).toBe(false);
    expect(underSkills('characters/aiko/character.md')).toBe(false);
    expect(underSkills(undefined)).toBe(false);
    expect(underSkills('')).toBe(false);
  });

  it('is false for the skills directory itself, which is not in a skill', () => {
    expect(underSkills(SKILLS_DIR)).toBe(false);
  });

  // `SKILLS_DIR` is spelt out rather than imported from `@vn/authoring` because every path this
  // pane sees arrives forward-slashed off the wire, and `join()` would not match on Windows
  it('is false for a backslashed spelling, which never reaches the renderer', () => {
    expect(underSkills('.aiagent\\skills\\continuity-pass\\SKILL.md')).toBe(false);
  });

  // `.aiagent/skillsets/…` starts with the same letters but is a different directory
  it('is false for a sibling whose name merely starts the same', () => {
    expect(underSkills('.aiagent/skillsets/x/SKILL.md')).toBe(false);
  });
});

describe('skillIdOf', () => {
  it('names the directory a file sits in', () => {
    expect(skillIdOf('.aiagent/skills/continuity-pass/SKILL.md')).toBe('continuity-pass');
    expect(skillIdOf('.aiagent/skills/lint-fountain/lib/helper.mjs')).toBe('lint-fountain');
  });

  it('is the id itself for the skill directory with nothing under it', () => {
    expect(skillIdOf('.aiagent/skills/continuity-pass')).toBe('continuity-pass');
  });

  it('is empty outside, including for the skills directory itself', () => {
    expect(skillIdOf('wiki/lore.md')).toBe('');
    expect(skillIdOf(SKILLS_DIR)).toBe('');
    expect(skillIdOf(undefined)).toBe('');
  });
});

describe('NEW_SKILL_PROMPT', () => {
  it('names the directory and the three front-matter keys', () => {
    expect(NEW_SKILL_PROMPT).toContain(SKILLS_DIR);
    expect(NEW_SKILL_PROMPT).toContain('name');
    expect(NEW_SKILL_PROMPT).toContain('description');
    expect(NEW_SKILL_PROMPT).toContain('when-to-use');
  });

  // The prompt ends on a blank to fill, because one that read as a finished request would let an
  // author send a turn asking for "a skill" and nothing else
  it('ends mid-sentence, so the form opens on something to finish', () => {
    expect(NEW_SKILL_PROMPT.endsWith(': ')).toBe(true);
  });
});

describe('askSkillAction', () => {
  it('opens the agent form on the prompt, rather than sending it', () => {
    expect(askSkillAction()).toEqual({
      ok     : true,
      id     : 'agent.run',
      props  : { input: NEW_SKILL_PROMPT },
      label  : 'Ask the agent for a skill…',
      tooltip: 'Open the agent form with a request for a new skill — you say what it should do',
      form   : true,
    });
  });
});

describe('controls', () => {
  const state = (over: Partial<SkillsState> = {}): SkillsState => ({
    path : '.aiagent/skills/continuity-pass/SKILL.md',
    dirty: true,
    ...over,
  });

  it('lists the save button and the hint door, each key once', () => {
    for (const s of [state(), state({ dirty: false }), state({ path: '' })]) {
      const listed = controls(s);
      const each = [saveOffer(s.path, s.dirty), askSkillAction()];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
