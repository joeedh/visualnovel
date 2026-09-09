import {
  cardAction,
  clearAction,
  controls,
  emptyBecause,
  gateAction,
  reloadAction,
  runAction,
  showing,
  tickAction,
  type ListFilter,
} from '../tasklist.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { ImageParams, TaskStatus } from '@vn/types';
import type { Task } from '../../../src/shared/ipc';
import type { Selection } from '../selection.js';

const PARAMS: ImageParams = { modelId: 'mock-image' };

const task = (hash: string, status: TaskStatus): Task => ({
  hash,
  kind: 'location_ref',
  deps: [],
  status,
  attempts: [],
  inputs  : { locationId: 'classroom', variant: 'day', prompt: '', refs: [], params: PARAMS },
});

const filter = (over: Partial<ListFilter> = {}): ListFilter => ({
  cleared    : new Set(),
  onlyDone   : false,
  onlyRunning: false,
  onlyFailed : false,
  ...over,
});

const TASKS = [
  task('a', 'done'),
  task('b', 'failed'),
  task('c', 'pending'),
  task('d', 'running'),
  task('e', 'needs_human'),
];

describe('showing', () => {
  it('shows everything by default', () => {
    expect(showing(TASKS, filter()).map((t) => t.hash)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps only what succeeded under the filter — a failure has finished but is not done', () => {
    expect(showing(TASKS, filter({ onlyDone: true })).map((t) => t.hash)).toEqual(['a']);
  });

  it('drops what Clear took out, filter or no filter', () => {
    const cleared = new Set(['a', 'b']);
    expect(showing(TASKS, filter({ cleared })).map((t) => t.hash)).toEqual(['c', 'd', 'e']);
    expect(showing(TASKS, filter({ cleared, onlyDone: true }))).toEqual([]);
  });

  it('keeps only what is moving under “only running”', () => {
    expect(showing(TASKS, filter({ onlyRunning: true })).map((t) => t.hash)).toEqual(['d']);
  });

  // This is the tick an author reaches for after a run that did not produce what they expected,
  // and a shot that exhausted its refinements is the likeliest answer, so a tick named for failure
  // keeps it rather than hiding it
  it('keeps what stopped and wants a person, needs_human included', () => {
    expect(showing(TASKS, filter({ onlyFailed: true })).map((t) => t.hash)).toEqual(['b', 'e']);
  });

  // The ticks are independent rather than one four-state control, and no two of the statuses
  // overlap, so two ticks on is a request for nothing and answering nothing is correct
  it('shows nothing when two status ticks are on', () => {
    expect(showing(TASKS, filter({ onlyDone: true, onlyRunning: true }))).toEqual([]);
    expect(showing(TASKS, filter({ onlyDone: true, onlyFailed: true }))).toEqual([]);
  });
});

describe('emptyBecause', () => {
  it('asks for a run when nothing has ever been planned', () => {
    expect(emptyBecause([], filter())).toContain('run the pipeline');
  });

  it('blames Clear when Clear is what emptied it', () => {
    const cleared = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(emptyBecause(TASKS, filter({ cleared }))).toContain('Refresh brings it back');
  });

  // The defect this module exists for: Clear takes out exactly what `only done` keeps, so with
  // both on, the filter used to be blamed, telling the author nothing had finished when what
  // Clear had just removed included the tasks that had
  it('still blames Clear when the filter is on as well', () => {
    const cleared = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(emptyBecause(TASKS, filter({ cleared, onlyDone: true }))).toContain(
      'Refresh brings it back',
    );
  });

  it('blames the filter only while something uncleared is left to reveal', () => {
    expect(emptyBecause([task('c', 'pending')], filter({ onlyDone: true }))).toContain('untick');
  });

  it('names “only running” when that is the tick that emptied it', () => {
    expect(emptyBecause([task('a', 'done')], filter({ onlyRunning: true }))).toContain(
      'Nothing is running',
    );
  });

  it('names “only failed” when that is the tick that emptied it', () => {
    expect(emptyBecause([task('a', 'done')], filter({ onlyFailed: true }))).toContain(
      'flagged for a person',
    );
  });

  // Blaming whichever tick is tested first would tell the author to untick the one they need.
  it('names every tick that is on rather than one of them', () => {
    expect(emptyBecause(TASKS, filter({ onlyDone: true, onlyRunning: true }))).toContain(
      'done and running at once',
    );
    const three = emptyBecause(
      TASKS,
      filter({ onlyDone: true, onlyRunning: true, onlyFailed: true }),
    );
    expect(three).toContain('done and running and failed');
    expect(three).toContain('all but one of the 3');
  });
});

describe('runAction', () => {
  it('opens the run form rather than starting a run off the button', () => {
    expect(runAction()).toEqual({
      ok     : true,
      id     : 'pipeline.run',
      props  : {},
      label  : '▸ Run',
      tooltip: 'Open the run form, where the flags are spelled out before anything is spent',
      form   : true,
    });
  });
});

describe('gateAction', () => {
  it('opens the approval form on the one character the run is waiting on', () => {
    expect(gateAction('aiko')).toEqual({
      ok     : true,
      id     : 'gate.approve',
      props  : { characterId: 'aiko' },
      on     : 'aiko',
      label  : 'RESOLVE →',
      tooltip: "Approve aiko's portrait, which is what the rest of the run is waiting on",
      form   : true,
    });
  });

  it('keys each gate bar by its character, so two bars are two anchors', () => {
    expect(keyOf(gateAction('aiko'))).toBe('cmd:gate.approve#aiko');
    expect(keyOf(gateAction('ren'))).toBe('cmd:gate.approve#ren');
  });
});

describe('cardAction', () => {
  const NONE: Selection = {
    sceneId    : '',
    shotId     : '',
    characterId: '',
    docPath    : '',
    assetHash  : '',
    graphSlug  : '',
  };
  const shot: Task = {
    hash    : 'f1e2d3c4',
    kind    : 'shot_image',
    deps    : [],
    status  : 'needs_human',
    attempts: [],
    output  : 'a1b2c3d4',
    inputs  : { shotId: 'arrival__s1', prompt: '', refs: [], params: PARAMS },
  };

  it('publishes the task and what it names, then opens its picture elsewhere', () => {
    expect(cardAction(shot, NONE)).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { taskHash: 'f1e2d3c4', sceneId: 'arrival', shotId: 'arrival__s1' },
      on     : 'task/f1e2d3c4',
      label  : 'shot_image',
      tooltip:
        'Open what this shot_image drew in the asset editor — the last frame it rendered, ' +
        'accepted or not; every other pane follows the pick',
      then: [
        { id: 'view.open', props: { editor: 'asset', where: 'elsewhere', subject: 'a1b2c3d4' } },
      ],
    });
  });

  it('opens the last attempt with bytes when the task itself left none', () => {
    const tried: Task = {
      ...shot,
      output  : undefined,
      attempts: [{ attempt: 1, refs: [], reviews: [], output: 'e5f6a7b8' }],
    };
    expect(cardAction(tried, NONE)).toMatchObject({
      then: [{ id: 'view.open', props: { subject: 'e5f6a7b8' } }],
    });
  });

  it('only publishes a task that drew nothing', () => {
    const drewNothing = task('a', 'pending');
    const offer = cardAction(drewNothing, NONE);
    expect(offer).toMatchObject({ id: 'ui.publish', props: { taskHash: 'a' } });
    expect('then' in offer).toBe(false);
    expect(keyOf(offer)).toBe('item:task/a');
  });
});

describe('the bar’s view controls', () => {
  it('keys each status tick by the status it keeps', () => {
    expect(tickAction('done')).toMatchObject({
      id   : 'pane.view',
      props: { what: 'filter' },
      on   : 'done',
      label: 'only done',
    });
    expect(tickAction('failed').tooltip).toMatch(/needs_human/);
  });

  it('refuses Clear finished with nothing to clear, and says what it does otherwise', () => {
    expect(clearAction(false)).toMatchObject({
      ok     : false,
      refusal: { reason: 'Nothing finished is left in the list to take out of it.' },
      on     : 'clear',
    });
    expect(clearAction(true)).toMatchObject({ ok: true, props: { what: 'filter' } });
    expect(clearAction(true).tooltip).toMatch(/Refresh brings them back/);
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload' });
  });
});

const BAR = [
  'fx:pane.view#done',
  'fx:pane.view#running',
  'fx:pane.view#failed',
  'fx:pane.view#clear',
  'fx:pane.view#reload',
];

describe('controls', () => {
  it('lists the cards after the bar', () => {
    const NONE: Selection = {
      sceneId    : '',
      shotId     : '',
      characterId: '',
      docPath    : '',
      assetHash  : '',
      graphSlug  : '',
    };
    const listed = controls({ gatePending: [], cards: { tasks: TASKS, selection: NONE } });
    expect(listed.map(keyOf)).toEqual([
      'cmd:pipeline.run',
      ...BAR,
      ...TASKS.map((t) => `item:task/${t.hash}`),
    ]);
  });

  it('lists the run button, one gate per pending character and the bar, each key once', () => {
    for (const gatePending of [[], ['aiko'], ['aiko', 'ren']]) {
      const listed = controls({ gatePending });
      const each = [
        runAction(),
        ...gatePending.map(gateAction),
        tickAction('done'),
        tickAction('running'),
        tickAction('failed'),
        clearAction(false),
        reloadAction(),
      ];
      expect(listed.map(keyOf)).toEqual(each.map(keyOf));
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(controls({ gatePending: [], clearable: true }).find((o) => o.on === 'clear')?.ok).toBe(
      true,
    );
  });
});
