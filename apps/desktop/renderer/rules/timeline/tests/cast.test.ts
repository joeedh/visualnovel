import type { CoverageShot, SceneCoverage } from '../../../../src/shared/ipc';
import {
  requireCastInvocation,
  requireCastTitle,
  shotCast,
  subjectsInvocation,
  variantInvocation,
  withCharacter,
  withoutCharacter,
} from '../cast.js';

const shot = (id: string, subjects: string[], castOptional?: boolean): CoverageShot => ({
  id,
  framing: 'medium',
  subjects,
  location: 'night',
  ...(castOptional ? { castOptional: true } : {}),
  outfits    : {},
  coversLines: ['club:L1'],
  status     : 'accepted',
  drift      : 'current',
});

const coverage = (shots: CoverageShot[]): SceneCoverage => ({
  sceneId : 'club',
  location: 'club_room',
  heading : 'INT. CLUB ROOM - NIGHT',
  lines   : [],
  shots,
  cast      : [],
  characters: ['aiko', 'ben', 'cho'],
  variants  : ['day', 'night'],
  decomposed: true,
});

describe('shotCast', () => {
  it('names who is framed and who is left to add', () => {
    const cast = shotCast(coverage([shot('club__beat1', ['ben'])]), 'club__beat1');
    expect(cast).toMatchObject({
      scene   : 'club',
      shot    : 'club__beat1',
      framed  : ['ben'],
      spare   : ['aiko', 'cho'],
      required: true,
      variant : 'night',
      variants: ['day', 'night'],
    });
  });

  it('reads a relaxed shot as not required', () => {
    const cast = shotCast(coverage([shot('club__beat1', ['ben'], true)]), 'club__beat1');
    expect(cast?.required).toBe(false);
  });

  it('answers nothing with no selection, and nothing for a shot the coverage lost', () => {
    expect(shotCast(coverage([shot('club__beat1', [])]), null)).toBeNull();
    expect(shotCast(coverage([shot('club__beat1', [])]), 'club__beat9')).toBeNull();
    expect(shotCast(null, 'club__beat1')).toBeNull();
  });
});

describe('the lists a control asks for', () => {
  const cast = shotCast(coverage([shot('club__beat1', ['ben'])]), 'club__beat1')!;

  it('appends the character added rather than reordering the rest', () => {
    expect(withCharacter(cast, 'aiko')).toEqual(['ben', 'aiko']);
  });

  it('leaves a list that already frames them alone', () => {
    expect(withCharacter(cast, 'ben')).toEqual(['ben']);
  });

  it('drops the one removed', () => {
    expect(withoutCharacter(cast, 'ben')).toEqual([]);
  });
});

describe('the invocations the controls run', () => {
  const cast = shotCast(coverage([shot('club__beat1', ['ben'])]), 'club__beat1')!;

  it('sends a cast list comma-separated, the way the prop reads it', () => {
    expect(subjectsInvocation(cast, ['ben', 'aiko'])).toEqual({
      id   : 'story.setSubjects',
      props: { scene: 'club', shot: 'club__beat1', subjects: 'ben,aiko' },
    });
  });

  it('sends an empty cast list as an empty string', () => {
    expect(subjectsInvocation(cast, []).props.subjects).toBe('');
  });

  it('sends the demand as a boolean', () => {
    expect(requireCastInvocation(cast, false)).toEqual({
      id   : 'story.requireCast',
      props: { scene: 'club', shot: 'club__beat1', required: false },
    });
  });

  it('sends a variant change through the command that owns the rule', () => {
    expect(variantInvocation(cast, 'day')).toEqual({
      id   : 'story.setVariant',
      props: { scene: 'club', shot: 'club__beat1', variant: 'day' },
    });
  });
});

describe('requireCastTitle', () => {
  it('says what clearing it would stop', () => {
    const cast = shotCast(coverage([shot('club__beat1', ['ben'])]), 'club__beat1')!;
    expect(requireCastTitle(cast)).toContain('stop the reviewer calling ben missing');
  });

  it('says what setting it would start', () => {
    const cast = shotCast(coverage([shot('club__beat1', ['ben'], true)]), 'club__beat1')!;
    expect(requireCastTitle(cast)).toContain('treat ben as missing');
  });

  it('says why it is pointless on a shot that frames nobody', () => {
    const cast = shotCast(coverage([shot('club__beat1', [])]), 'club__beat1')!;
    expect(requireCastTitle(cast)).toContain('Nobody is in this shot');
  });
});
