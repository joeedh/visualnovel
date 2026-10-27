/** The Play pane's situations: where in the story the runner is, and how the scene ends. */
import { situations } from './situation.js';
import type { PlayState } from '../play.js';

export const SITUATIONS = situations<PlayState>(
  {
    name : 'start',
    why  : 'The story is at its first scene, so Back is refused with the reason.',
    state: { canBack: false },
  },
  {
    name : 'mid-story',
    why  : 'A scene has been played, so Back is offered.',
    state: { canBack: true },
  },
  {
    name : 'choice',
    why  : 'The scene ends in two choices, so the panel offers each branch by its label.',
    state: {
      canBack: true,
      ended: {
        choices: [
          { label: 'Go in', goto: 'cafe' },
          { label: 'Walk on', goto: 'street' },
        ],
      },
    },
  },
  {
    name : 'story-end',
    why  : 'The last scene has ended with nowhere to go, so the panel offers nothing but The End.',
    state: { canBack: true, ended: { choices: [] } },
  },
);
