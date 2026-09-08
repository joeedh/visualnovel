/** The branch card menu's situations: a written scene, and a stub a goto names but nothing wrote. */
import { situations } from './situation.js';

export interface CardMenuState {
  id: string;
  stub: boolean;
}

export const SITUATIONS = situations<CardMenuState>(
  {
    name : 'scene',
    why: 'A written scene is offered its script, opened elsewhere so the canvas is never covered.',
    state: { id: 'arrival', stub: false },
  },
  {
    name : 'stub',
    why  : 'A stub has no script, so the one act it has is writing the scene, as a form.',
    state: { id: 'departure', stub: true },
  },
);
