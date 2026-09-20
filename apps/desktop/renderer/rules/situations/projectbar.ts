/**
 * The Project pane's situations: whether the art-style box differs from `project.yaml`, and which
 * builtin skills the file has on.
 */
import { situations } from './situation.js';
import type { ProjectBarState } from '../projectbar.js';
import type { BuiltinSkillView } from '../../../src/shared/ipc.js';

/** The shipped catalog as the pane sees it, with one skill switched off. */
const BUILTIN: BuiltinSkillView[] = [
  {
    id         : 'branching',
    name       : 'Branching',
    description: 'Add a choice and the branches it opens.',
    enabled    : true,
  },
  {
    id         : 'full-production',
    name       : 'Full production',
    description: 'Take a premise through to a complete, generated VN.',
    enabled    : false,
  },
  {
    id         : 'new-character',
    name       : 'New character',
    description: 'Add a character with a sheet and a place in the story.',
    enabled    : true,
  },
];

export const SITUATIONS = situations<ProjectBarState>(
  {
    name : 'clean',
    why: 'The box matches the file, so Apply is refused with No changes; the box, reload, the three model pickers and the builtin-skill checkboxes stay offered, each with the list the file would hold after it.',
    state: {
      opened       : true,
      dirty        : false,
      imageModel   : 'gemini-2.5-flash-image',
      textModel    : 'claude-opus-4-8',
      visionModels : ['gemini-2.5-flash', 'claude-opus-4-8'],
      shotForm     : 'frames',
      bubbleNames  : false,
      builtinSkills: BUILTIN,
    },
  },
  {
    name : 'dirty',
    why: 'The box holds something the file does not, so Apply is offered; the file storyboards in pages, which the shot-form picker shows.',
    state: {
      opened       : true,
      dirty        : true,
      imageModel   : 'gemini-2.5-flash-image',
      textModel    : 'claude-opus-4-8',
      visionModels : ['gemini-2.5-flash'],
      shotForm     : 'pages',
      bubbleNames  : false,
      builtinSkills: [],
    },
  },
  {
    name : 'openrouter-model',
    why: 'The file names an OpenRouter model, which the picker’s button shows as its label, and a listing is cached, so Refresh models says its date.',
    state: {
      opened       : true,
      dirty        : false,
      imageModel   : 'openai/gpt-image-2',
      textModel    : 'gemini-2.5-pro',
      visionModels : [],
      catalogAsOf  : '2026-09-15',
      shotForm     : 'frames',
      bubbleNames  : false,
      builtinSkills: [],
    },
  },
  {
    name : 'no-project',
    why: 'No project is open, so Apply, the box, the pickers, Refresh models and every checkbox are refused.',
    state: {
      opened       : false,
      dirty        : false,
      imageModel   : '',
      textModel    : '',
      visionModels : [],
      shotForm     : 'frames',
      bubbleNames  : false,
      builtinSkills: BUILTIN,
    },
  },
);
