import { modeAction, runAction, stopAction } from '../headerbar.js';
import { busyControls } from '../busy.js';
import { BUSY_REPORT, BUSY_RUN } from '../../../src/shared/ipc.js';

describe('runAction', () => {
  it('runs for real in a live app and dry in a preview', () => {
    expect(runAction('', true)).toMatchObject({ ok: true, props: { mock: false } });
    expect(runAction('', false)).toMatchObject({ ok: true, props: { mock: true } });
  });

  it('refuses while other work is in flight, and still names the command', () => {
    expect(runAction(BUSY_RUN, true)).toEqual({
      ok: false,
      id: 'pipeline.run',
      reason: `Cannot start: ${BUSY_RUN} is already in progress.`,
    });
  });
});

describe('stopAction', () => {
  it('stops whatever the header drew a spinner for', () => {
    expect(stopAction(busyControls(BUSY_RUN))).toMatchObject({ ok: true, id: 'pipeline.stop' });
    expect(stopAction(busyControls(BUSY_REPORT))).toMatchObject({ ok: true, id: 'report.stop' });
  });

  it('refuses when nothing it stops is running', () => {
    expect(stopAction(undefined)).toEqual({
      ok: false,
      id: 'pipeline.stop',
      reason: 'Nothing is running.',
    });
  });
});

describe('modeAction', () => {
  it('names the mode it would move to, and labels the one it is in', () => {
    expect(modeAction('plan')).toEqual({
      ok: true,
      id: 'agent.setMode',
      props: { mode: 'execute' },
      label: 'PLAN',
    });
    expect(modeAction('execute')).toMatchObject({ props: { mode: 'plan' }, label: 'EXECUTE' });
  });
});
