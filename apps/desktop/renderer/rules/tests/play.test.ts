import {
  backAction,
  choiceAction,
  continueAction,
  controls,
  loadAction,
  resetAction,
  saveAction,
  stageAction,
} from '../play.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('the Play pane’s offers', () => {
  it('step, mark and page as view effects, keyed by what each does', () => {
    expect(stageAction()).toEqual({
      ok     : true,
      id     : 'pane.view',
      props  : { what: 'step' },
      on     : 'forward',
      label  : 'Stage',
      tooltip: 'Click anywhere to advance to the next line',
    });
    expect(backAction(true)).toMatchObject({ ok: true, props: { what: 'step' }, on: 'back' });
    expect(backAction(false)).toMatchObject({
      ok     : false,
      refusal: { reason: 'You are at the beginning; there is nothing to step back to.' },
    });
    expect(saveAction()).toMatchObject({ props: { what: 'mark' }, on: 'save' });
    expect(loadAction()).toMatchObject({ props: { what: 'mark' }, on: 'load' });
    expect(resetAction()).toMatchObject({ props: { what: 'page' }, on: 'reset' });
    expect(choiceAction({ label: 'Go in', goto: 'cafe' })).toMatchObject({
      on     : 'choose/cafe',
      label  : 'Go in',
      tooltip: 'Take this branch — the story goes on at cafe',
    });
    expect(continueAction()).toMatchObject({ on: 'continue', label: 'Continue ▸' });
  });
});

describe('controls', () => {
  it('lists the stage, the bar, then the panel’s choices or Continue, each key once', () => {
    const bar = [
      'fx:pane.view#forward',
      'fx:pane.view#back',
      'fx:pane.view#save',
      'fx:pane.view#load',
      'fx:pane.view#reset',
    ];
    expect(controls({ canBack: false }).map(keyOf)).toEqual(bar);
    const choices = [{ label: 'Go in', goto: 'cafe' }];
    expect(controls({ canBack: true, ended: { choices, next: false } }).map(keyOf)).toEqual([
      ...bar,
      'fx:pane.view#choose/cafe',
    ]);
    const ends = controls({ canBack: true, ended: { choices: [], next: true } });
    expect(ends.map(keyOf)).toEqual([...bar, 'fx:pane.view#continue']);
    expect(duplicateKeys(ends)).toEqual([]);
  });
});
