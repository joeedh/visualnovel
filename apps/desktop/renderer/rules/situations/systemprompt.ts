/** The system-prompt viewer's situations: whether a prompt has been read. */
import { situations } from './situation.js';
import type { SystemPromptState } from '../systemprompt.js';

export const SITUATIONS = situations<SystemPromptState>(
  {
    name : 'no-prompt',
    why  : 'No project is open, so there is no prompt and Copy is refused.',
    state: { sections: 0 },
  },
  {
    name : 'prompt',
    why  : 'A prompt of three sections has been read, so Copy is offered.',
    state: { sections: 3 },
  },
);
