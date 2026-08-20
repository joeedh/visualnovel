import { SETTLED, WRITE_PENDING, beginWrite, busyLabel, revealBusy } from '../busy.js';

describe('the strip while a write is in flight', () => {
  it('locks quietly at first: pending, but nothing shown yet', () => {
    const busy = beginWrite('Moving shot');
    expect(busy.pending).toBe(true);
    expect(busyLabel(busy)).toBeNull();
  });

  it('becomes a bar carrying the command name once the delay elapses', () => {
    const busy = revealBusy(beginWrite('Moving shot'));
    expect(busyLabel(busy)).toBe('Moving shot…');
  });

  // The timer fires after the write already landed, so the reveal must not bring the bar back
  it('leaves a settled write settled when the delay fires late', () => {
    expect(revealBusy(SETTLED)).toBe(SETTLED);
    expect(busyLabel(revealBusy(SETTLED))).toBeNull();
  });

  it('says the one sentence a locked surface has, as a refusal', () => {
    expect(WRITE_PENDING.tone).toBe('refused');
    expect(WRITE_PENDING.text).toBe('Waiting for the last edit to land.');
  });
});
