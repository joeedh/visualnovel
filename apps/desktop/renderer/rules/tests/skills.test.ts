import {
  NEW_SKILL_PROMPT,
  READ_TIP,
  RELOAD_TIP,
  SKILLS_DIR,
  TEXT_TIP,
  askSkillAction,
  cloneOffer,
  controls,
  readOnlyReason,
  skillIdOf,
  skillSaveOffer,
  skillTextBox,
  tierBadge,
  underSkills,
  type SkillsState,
} from '../skills.js';
import { reloadOffer, saveOffer, textBox } from '../docbuffer.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('underSkills', () => {
  it('is true for a file inside a skill', () => {
    expect(underSkills('.aiagent/skills/continuity-pass/SKILL.md')).toBe(true);
    expect(underSkills('.aiagent/skills/lint-fountain/run.mjs')).toBe(true);
  });

  it('is true for a user or builtin skill under its tier prefix', () => {
    expect(underSkills('<builtin>/branching/SKILL.md')).toBe(true);
    expect(underSkills('<user>/skills/casting/SKILL.md')).toBe(true);
    expect(underSkills('<builtin>')).toBe(false);
    expect(underSkills('<user>/skills')).toBe(false);
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

  it('reads the id under a tier prefix the same way', () => {
    expect(skillIdOf('<builtin>/branching/SKILL.md')).toBe('branching');
    expect(skillIdOf('<user>/skills/casting')).toBe('casting');
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

const PROJECT = '.aiagent/skills/continuity-pass/SKILL.md';
const BUILTIN = '<builtin>/branching/SKILL.md';
const USER = '<user>/skills/casting/SKILL.md';

describe('readOnlyReason and tierBadge', () => {
  it('is empty for a project skill, which is the ordinary case', () => {
    expect(readOnlyReason(PROJECT)).toBe('');
    expect(tierBadge(PROJECT)).toBe('');
    expect(tierBadge('')).toBe('');
  });

  it('names the tier, and the button that makes an editable copy', () => {
    expect(readOnlyReason(BUILTIN)).toContain('Clone');
    expect(readOnlyReason(USER)).toContain('Clone');
    expect(tierBadge(BUILTIN)).toBe('builtin');
    expect(tierBadge(USER)).toBe('user');
  });
});

describe('skillSaveOffer and skillTextBox', () => {
  it('are the plain doc-buffer offers for a project skill and for nothing open', () => {
    expect(skillSaveOffer(PROJECT, true)).toEqual(saveOffer(PROJECT, true));
    expect(skillSaveOffer('', false)).toEqual(saveOffer('', false));
    expect(skillTextBox(PROJECT)).toEqual(textBox(PROJECT, TEXT_TIP));
  });

  it('refuse a builtin or user skill with the read-only reason, not with Nothing to save', () => {
    for (const path of [BUILTIN, USER]) {
      expect(skillSaveOffer(path, false)).toMatchObject({
        ok     : false,
        id     : 'doc.write',
        refusal: { reason: readOnlyReason(path) },
      });
      expect(skillTextBox(path)).toMatchObject({
        ok     : false,
        id     : 'doc.write',
        on     : 'text',
        tooltip: READ_TIP,
        refusal: { reason: readOnlyReason(path) },
      });
    }
  });
});

describe('cloneOffer', () => {
  it('offers the open skill’s id to the other tiers', () => {
    expect(cloneOffer(BUILTIN, 'project')).toEqual({
      ok     : true,
      id     : 'skill.cloneToProject',
      props  : { id: 'branching' },
      label  : 'Clone into project',
      tooltip: expect.stringContaining('.aiagent/skills'),
    });
    expect(cloneOffer(BUILTIN, 'user')).toMatchObject({
      ok   : true,
      id   : 'skill.cloneToUser',
      props: { id: 'branching' },
      label: 'Clone into user folder',
    });
    expect(cloneOffer(USER, 'project')).toMatchObject({ ok: true, props: { id: 'casting' } });
    expect(cloneOffer(PROJECT, 'user')).toMatchObject({
      ok   : true,
      props: { id: 'continuity-pass' },
    });
  });

  it('refuses the tier the skill is already in, and nothing open', () => {
    expect(cloneOffer(PROJECT, 'project')).toMatchObject({
      ok     : false,
      refusal: { reason: 'This is already a project skill.' },
    });
    expect(cloneOffer(USER, 'user')).toMatchObject({
      ok     : false,
      refusal: { reason: 'This is already a user skill.' },
    });
    expect(cloneOffer('', 'project')).toMatchObject({
      ok     : false,
      id     : 'skill.cloneToProject',
      refusal: { reason: 'No skill is open.' },
    });
    expect(cloneOffer('wiki/lore.md', 'user')).toMatchObject({
      ok     : false,
      refusal: { reason: 'No skill is open.' },
    });
  });
});

describe('controls', () => {
  const state = (over: Partial<SkillsState> = {}): SkillsState => ({
    path : PROJECT,
    dirty: true,
    ...over,
  });

  it('lists Save, reload, the two Clones, the hint door and the text box, each key once', () => {
    for (const s of [
      state(),
      state({ dirty: false }),
      state({ path: '' }),
      state({ path: BUILTIN, dirty: false }),
      state({ path: USER, dirty: false }),
    ]) {
      const listed = controls(s);
      const each = [
        skillSaveOffer(s.path, s.dirty),
        reloadOffer(RELOAD_TIP),
        cloneOffer(s.path, 'project'),
        cloneOffer(s.path, 'user'),
        askSkillAction(),
        skillTextBox(s.path),
      ];
      expect(listed).toEqual(each);
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(controls(state()).map(keyOf)).toEqual([
      'cmd:doc.write',
      'fx:pane.view#reload',
      'cmd:skill.cloneToProject',
      'cmd:skill.cloneToUser',
      'cmd:agent.run',
      'cmd:doc.write#text',
    ]);
  });
});
