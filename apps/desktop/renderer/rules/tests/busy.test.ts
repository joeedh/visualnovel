/**
 * This file covers which long-running work the header offers to stop, and what it says while it runs.
 *
 * The absence matters most: an authoring turn draws no Stop in the header, because the
 * conversation editor owns that button, and two Stop buttons would disagree about who ended the turn.
 */
import { busyControls } from '../busy.js';
import { BUSY_AGENT, BUSY_PASS, BUSY_REPORT, BUSY_RUN } from '../../../src/shared/ipc.js';

describe('what the header draws for the work in flight', () => {
  it('stops a pipeline run through the pipeline', () => {
    expect(busyControls(BUSY_RUN)?.stop).toBe('pipeline.stop');
    expect(busyControls(BUSY_RUN)?.stops).toContain('Finished work is kept.');
  });

  it('says a pass takes no further rounds, which a plain run has nothing to say about', () => {
    expect(busyControls(BUSY_PASS)?.stop).toBe('pipeline.stop');
    expect(busyControls(BUSY_PASS)?.stops).toContain('no further rounds');
    expect(busyControls(BUSY_RUN)?.stops).not.toContain('no further rounds');
  });

  it('stops a debug turn through its own command rather than the pipeline’s', () => {
    expect(busyControls(BUSY_REPORT)?.stop).toBe('report.stop');
  });

  it('draws nothing for an authoring turn, which the conversation editor stops', () => {
    expect(busyControls(BUSY_AGENT)).toBeUndefined();
  });

  it('draws nothing for a kind it does not know, rather than a Stop that does nothing', () => {
    expect(busyControls('')).toBeUndefined();
    expect(busyControls('something later')).toBeUndefined();
  });
});

describe('what the spinner says', () => {
  it('counts a run down, and says task once when one is left', () => {
    expect(busyControls(BUSY_RUN)?.progress(3, 2)).toBe(
      'The pipeline is running — 3 task(s) done, 2 tasks left.',
    );
    expect(busyControls(BUSY_RUN)?.progress(3, 1)).toContain('1 task left.');
  });

  it('counts a debug turn up, because nothing knows how many steps are left', () => {
    expect(busyControls(BUSY_REPORT)?.progress(4, 0)).toBe(
      'The debug agent is reading — 4 step(s) so far.',
    );
  });
});
