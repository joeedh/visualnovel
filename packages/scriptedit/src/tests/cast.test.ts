import type { Scene, Shot, ShotSubject } from '@vn/types';
import { requireShotCast, setShotSubjects } from '../cast.js';

const scene: Pick<Scene, 'id'> = { id: 'club' };
const CAST = ['aiko', 'ben', 'cho'];

const shots = (subjects: ShotSubject[], castOptional?: boolean): Shot[] => [
  {
    id: 'club__beat1',
    sceneId: 'club',
    framing: 'medium',
    location: 'day',
    subjects,
    ...(castOptional ? { castOptional: true } : {}),
    coversLines: ['club:L1'],
    status: 'generated',
  },
  {
    id: 'club__beat2',
    sceneId: 'club',
    framing: 'close',
    location: 'day',
    subjects: [{ characterId: 'ben' }],
    coversLines: ['club:L2'],
    status: 'generated',
  },
];

describe('setShotSubjects', () => {
  it('sets the list, in the order given, and leaves the other shots alone', () => {
    const op = setShotSubjects(shots([{ characterId: 'aiko' }]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['cho', 'aiko'],
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects.map((s) => s.characterId)).toEqual(['cho', 'aiko']);
    expect(op.shots[1]!.subjects.map((s) => s.characterId)).toEqual(['ben']);
    expect(op.message).toContain('drawn again');
  });

  it('keeps the outfit override of a character that stays', () => {
    const op = setShotSubjects(shots([{ characterId: 'aiko', outfit: 'gala' }]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['aiko', 'ben'],
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects).toEqual([
      { characterId: 'aiko', outfit: 'gala' },
      { characterId: 'ben' },
    ]);
  });

  it('drops the override of a character that leaves, and says so', () => {
    const op = setShotSubjects(shots([{ characterId: 'aiko', outfit: 'gala' }]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['ben'],
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects).toEqual([{ characterId: 'ben' }]);
    expect(op.message).toContain('aiko left it');
  });

  it('empties the list into a background plate', () => {
    const op = setShotSubjects(shots([{ characterId: 'aiko' }]), scene, CAST, {
      shot: 'club__beat1',
      subjects: [],
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects).toEqual([]);
    expect(op.message).toContain('background plate');
  });

  it('collapses a repeated character rather than framing them twice', () => {
    const op = setShotSubjects(shots([]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['aiko', 'aiko'],
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.subjects).toEqual([{ characterId: 'aiko' }]);
  });

  it('refuses a character no sheet describes, and names the ones there are', () => {
    const op = setShotSubjects(shots([]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['dan'],
    });
    expect(op).toMatchObject({ ok: false });
    if (op.ok) throw new Error('expected a refusal');
    expect(op.error).toContain('"dan"');
    expect(op.error).toContain('"aiko", "ben", "cho"');
  });

  it('refuses the list it already holds as a no-op', () => {
    const op = setShotSubjects(shots([{ characterId: 'aiko' }]), scene, CAST, {
      shot: 'club__beat1',
      subjects: ['aiko'],
    });
    expect(op).toMatchObject({ ok: false, noop: true });
  });

  it('refuses a shot the scene does not have', () => {
    const op = setShotSubjects(shots([]), scene, CAST, { shot: 'club__beat9', subjects: [] });
    expect(op).toMatchObject({ ok: false });
  });
});

describe('requireShotCast', () => {
  it('lets the cast out of frame without taking it off the shot', () => {
    const op = requireShotCast(shots([{ characterId: 'aiko' }]), scene, {
      shot: 'club__beat1',
      required: false,
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots[0]!.castOptional).toBe(true);
    expect(op.shots[0]!.subjects).toEqual([{ characterId: 'aiko' }]);
    expect(op.message).toContain('references');
  });

  it('requires it again by clearing the flag rather than storing a false', () => {
    const op = requireShotCast(shots([{ characterId: 'aiko' }], true), scene, {
      shot: 'club__beat1',
      required: true,
    });
    if (!op.ok) throw new Error(op.error);
    expect('castOptional' in op.shots[0]!).toBe(false);
  });

  it('refuses to relax a shot that frames nobody', () => {
    const op = requireShotCast(shots([]), scene, { shot: 'club__beat1', required: false });
    expect(op).toMatchObject({ ok: false });
    if (op.ok) throw new Error('expected a refusal');
    expect(op.error).toContain('frames nobody');
  });

  it('refuses the state it already holds as a no-op', () => {
    const op = requireShotCast(shots([{ characterId: 'aiko' }]), scene, {
      shot: 'club__beat1',
      required: true,
    });
    expect(op).toMatchObject({ ok: false, noop: true });
  });
});
