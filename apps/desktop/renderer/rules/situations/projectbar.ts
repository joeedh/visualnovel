/** The Project pane's situations: whether the art-style box differs from `project.yaml`. */
import { situations } from './situation.js';
import type { ProjectBarState } from '../projectbar.js';

export const SITUATIONS = situations<ProjectBarState>(
  {
    name : 'clean',
    why: 'The box matches the file, so Apply is refused with No changes; the box and reload stay offered.',
    state: { opened: true, dirty: false },
  },
  {
    name : 'dirty',
    why  : 'The box holds something the file does not, so Apply is offered.',
    state: { opened: true, dirty: true },
  },
  {
    name : 'no-project',
    why  : 'No project is open, so Apply and the box are refused.',
    state: { opened: false, dirty: false },
  },
);
