import { localLineId } from '../script.js';

describe('localLineId', () => {
  it('drops the scene half, which is the column heading', () => {
    expect(localLineId('arrival:L4')).toBe('L4');
  });

  it('keeps an id it cannot split rather than showing an empty gutter', () => {
    expect(localLineId('L4')).toBe('L4');
  });

  it('splits at the last colon, so a scene id containing one still resolves', () => {
    expect(localLineId('act1:arrival:L12')).toBe('L12');
  });
});
