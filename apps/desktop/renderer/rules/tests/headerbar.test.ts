import { controls, modeAction, runAction, stopAction } from '../headerbar.js';
import { busyControls } from '../busy.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import { BUSY_REPORT, BUSY_RUN } from '../../../src/shared/ipc.js';

describe('runAction', () => {
  it('runs for real in a live app and dry in a preview, and says which', () => {
    expect(runAction('', true)).toEqual({
      ok     : true,
      id     : 'pipeline.run',
      props  : { mock: false },
      label  : '▶ Run',
      tooltip: 'Plan and render everything that is ready, to the next gate',
    });
    expect(runAction('', false)).toMatchObject({
      ok     : true,
      props  : { mock: true },
      tooltip: expect.stringContaining('cannot call a model'),
    });
  });

  it('refuses while other work is in flight, and still names the command', () => {
    expect(runAction(BUSY_RUN, true)).toMatchObject({
      ok     : false,
      id     : 'pipeline.run',
      label  : '▶ Run',
      refusal: { reason: `Cannot start: ${BUSY_RUN} is already in progress.` },
    });
  });
});

describe('stopAction', () => {
  it('stops whatever the header drew a spinner for, saying what stopping does', () => {
    expect(stopAction(busyControls(BUSY_RUN))).toMatchObject({
      ok     : true,
      id     : 'pipeline.stop',
      tooltip: busyControls(BUSY_RUN)!.stops,
    });
    expect(stopAction(busyControls(BUSY_REPORT))).toMatchObject({ ok: true, id: 'report.stop' });
  });

  it('refuses when nothing it stops is running', () => {
    expect(stopAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'pipeline.stop',
      refusal: { reason: 'Nothing is running.' },
    });
  });
});

describe('modeAction', () => {
  it('names the mode it would move to, and labels the one it is in', () => {
    expect(modeAction('plan')).toEqual({
      ok     : true,
      id     : 'agent.setMode',
      props  : { mode: 'execute' },
      label  : 'PLAN',
      tooltip: 'Plan mode: the agent reads but never writes. Click to let it apply edits.',
    });
    expect(modeAction('execute')).toMatchObject({ props: { mode: 'plan' }, label: 'EXECUTE' });
  });
});

describe('controls', () => {
  const states = [
    { busyWhat: '', live: true, agentMode: 'plan' },
    { busyWhat: BUSY_RUN, live: false, agentMode: 'execute' },
    { busyWhat: BUSY_REPORT, live: true, agentMode: 'plan' },
  ];

  it('lists every control the functions produce, each key once', () => {
    for (const state of states) {
      const listed = controls(state);
      const each = [
        runAction(state.busyWhat, state.live),
        stopAction(busyControls(state.busyWhat)),
        modeAction(state.agentMode),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});
