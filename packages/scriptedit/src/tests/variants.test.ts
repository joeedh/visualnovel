import type { Location, Scene, Shot } from '@vn/types';
import { setShotVariant } from '../variants.js';

const scene: Pick<Scene, 'id' | 'location'> = { id: 'club', location: 'club_room' };

const location = (id: string, variants: string[]): Location => ({
  id,
  name: id,
  description: '',
  palette: [],
  variants: variants.map((v) => ({ id: v, description: '' })),
  mined: false,
});

const CLUB = location('club_room', ['day', 'night']);

const shots = (variant: string): Shot[] => [
  {
    id: 'club__beat1',
    sceneId: 'club',
    framing: 'medium',
    location: variant,
    subjects: [],
    coversLines: ['club:L1'],
    status: 'generated',
  },
  {
    id: 'club__beat2',
    sceneId: 'club',
    framing: 'close',
    location: variant,
    subjects: [],
    coversLines: ['club:L2'],
    status: 'generated',
  },
];

describe('setShotVariant', () => {
  it('moves one shot and says the frame is drawn again', () => {
    const op = setShotVariant(shots('day'), scene, CLUB, {
      shot: 'club__beat1',
      variant: 'night',
    });
    if (!op.ok) throw new Error(op.error);
    expect(op.shots.map((s) => s.location)).toEqual(['night', 'day']);
    expect(op.message).toContain('"night"');
    expect(op.message).toContain('drawn again');
  });

  it('names the variants a location has when asked for one it does not', () => {
    const op = setShotVariant(shots('day'), scene, CLUB, {
      shot: 'club__beat1',
      variant: 'dusk',
    });
    expect(op).toMatchObject({ ok: false });
    if (op.ok) throw new Error('expected a refusal');
    expect(op.error).toContain('"day", "night"');
  });

  it('refuses an unknown shot, and a location that is not the scene’s', () => {
    expect(
      setShotVariant(shots('day'), scene, CLUB, { shot: 'club__beat9', variant: 'night' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('club__beat9') });
    expect(
      setShotVariant(shots('day'), scene, location('roof', ['day']), {
        shot: 'club__beat1',
        variant: 'day',
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('club_room') });
  });

  it('reports a shot already in that variant as a no-op rather than rewriting the file', () => {
    const op = setShotVariant(shots('night'), scene, CLUB, {
      shot: 'club__beat1',
      variant: 'night',
    });
    expect(op).toMatchObject({ ok: false, noop: true });
  });
});
