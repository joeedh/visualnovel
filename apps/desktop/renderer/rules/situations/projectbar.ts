/** The Project pane's situations: whether the art-style box differs from `project.yaml`. */
import { situations } from './situation.js';
import type { ProjectBarState } from '../projectbar.js';

export const SITUATIONS = situations<ProjectBarState>(
  {
    name : 'clean',
    why: 'The box matches the file, so Apply is refused with No changes; the box, reload and the image-model picker stay offered.',
    state: { opened: true, dirty: false, imageModel: 'gemini-2.5-flash-image' },
  },
  {
    name : 'dirty',
    why  : 'The box holds something the file does not, so Apply is offered.',
    state: { opened: true, dirty: true, imageModel: 'gemini-2.5-flash-image' },
  },
  {
    name : 'openrouter-model',
    why: 'The file names an OpenRouter model, which the picker’s button shows as its label, and a listing is cached, so Refresh models says its date.',
    state: {
      opened     : true,
      dirty      : false,
      imageModel : 'openai/gpt-image-2',
      catalogAsOf: '2026-09-15',
    },
  },
  {
    name : 'no-project',
    why  : 'No project is open, so Apply, the box, the picker and Refresh models are refused.',
    state: { opened: false, dirty: false, imageModel: '' },
  },
);
