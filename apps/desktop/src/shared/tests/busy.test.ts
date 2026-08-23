import { BUSY_AGENT, BUSY_PASS, BUSY_REPORT, BUSY_RUN, busyName, stopsWhat } from '../ipc.js';

describe('naming the work in flight', () => {
  it('says nothing when nothing is running', () => {
    expect(busyName([])).toBeUndefined();
  });

  it('names a pipeline pass over anything it contains', () => {
    expect(busyName([BUSY_RUN, BUSY_PASS])).toBe(BUSY_PASS);
  });

  it('names a report turn over an agent turn, whichever started first', () => {
    expect(busyName([BUSY_AGENT, BUSY_REPORT])).toBe(BUSY_REPORT);
    expect(busyName([BUSY_REPORT, BUSY_AGENT])).toBe(BUSY_REPORT);
  });

  it('names work it has no rank for rather than dropping it', () => {
    expect(busyName(['something new'])).toBe('something new');
  });

  it('describes what Stop does to the pass and to one run', () => {
    expect(stopsWhat(BUSY_PASS)).toContain('takes no further rounds');
    expect(stopsWhat(BUSY_RUN)).toContain('after the task it is on');
  });
});
