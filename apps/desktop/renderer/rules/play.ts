/**
 * What the Play pane offers. Every control here is a `pane.view` effect: the runner reads a
 * playable and moves through it, and nothing it does reaches a command. The stage and the choice
 * buttons step; Save, Load and Reset move the bookmark and the page.
 */
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';

/** What the Play pane reads when it draws its bar, its stage and the panel at a scene's end. */
export interface PlayState {
  /** Whether there is a scene before this one to step back to. */
  canBack: boolean;
  /** Drawn at the end of a scene: the choices it offers, or whether it simply continues. */
  ended?: { choices: readonly { label: string; goto: string }[]; next: boolean };
}

/** The stage itself: a click anywhere on it advances. Bound to Space, Enter and Right. */
export function stageAction(): Offer {
  return {
    ok: true,
    ...view('step'),
    on     : 'forward',
    label  : 'Stage',
    tooltip: 'Click anywhere to advance to the next line',
  };
}

/** Back, refused at the beginning with the reason. Bound to Left and Backspace. */
export function backAction(canBack: boolean): Offer {
  const control = { ...view('step'), on: 'back', label: '◂ Back' };
  if (!canBack) {
    return {
      ...refuse('You are at the beginning; there is nothing to step back to.'),
      ...control,
      tooltip: 'Step back to the scene before this one',
    };
  }
  return { ok: true, ...control, tooltip: 'Step back to the scene before this one' };
}

export function saveAction(): Offer {
  return {
    ok: true,
    ...view('mark'),
    on     : 'save',
    label  : 'Save',
    tooltip: 'Remember where you are, so Load comes back here',
  };
}

export function loadAction(): Offer {
  return {
    ok: true,
    ...view('mark'),
    on     : 'load',
    label  : 'Load',
    tooltip: 'Jump back to where Save left off',
  };
}

export function resetAction(): Offer {
  return {
    ok: true,
    ...view('page'),
    on     : 'reset',
    label  : 'Reset',
    tooltip: 'Start the story again from its first scene',
  };
}

/** One choice at the end of a branching scene. */
export function choiceAction(choice: { label: string; goto: string }): Offer {
  return {
    ok: true,
    ...view('step'),
    on     : `choose/${choice.goto}`,
    label  : choice.label,
    tooltip: `Take this branch — the story goes on at ${choice.goto}`,
  };
}

/** Continue, at the end of a scene that leads on to one more. */
export function continueAction(): Offer {
  return {
    ok: true,
    ...view('step'),
    on     : 'continue',
    label  : 'Continue ▸',
    tooltip: 'Play on to the scene this one leads to',
  };
}

/**
 * Every offer the Play pane draws from this module, in draw order: the stage, the bar's four,
 * then the end-of-scene panel's choices or its Continue.
 */
export function controls(state: PlayState): readonly Offer[] {
  const ended = state.ended;
  return [
    stageAction(),
    backAction(state.canBack),
    saveAction(),
    loadAction(),
    resetAction(),
    ...(ended ? ended.choices.map(choiceAction) : []),
    ...(ended && ended.next && ended.choices.length === 0 ? [continueAction()] : []),
  ];
}
