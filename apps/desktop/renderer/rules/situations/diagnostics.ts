/**
 * The problems popup's situations: a clean project, and three diagnostics of which only the one
 * naming a real scene becomes a row, with Script closed and then open.
 */
import { situations } from './situation.js';
import type { DiagnosticsState } from '../diagnostics.js';
import type { Diagnostic } from '@vn/types';

const DIAGNOSTICS: readonly Diagnostic[] = [
  { severity: 'error', code: 'dangling_line_id', message: 'names no line', where: 'arrival' },
  { severity: 'warning', code: 'bad_character', message: 'has no portrait', where: 'aiko' },
  { severity: 'error', code: 'missing_start', message: 'start names no scene', where: 'prologue' },
];

const SCENES = ['arrival', 'ending'];

export const SITUATIONS = situations<DiagnosticsState>(
  {
    name : 'clean',
    why  : 'Nothing is wrong with the project, so no row is drawn.',
    state: { diagnostics: [], scenes: SCENES, visible: ['documents'] },
  },
  {
    name : 'problems',
    why: 'Of three diagnostics only the one about a listed scene is a row; it opens Script elsewhere, since only the tree is up.',
    state: { diagnostics: DIAGNOSTICS, scenes: SCENES, visible: ['documents'] },
  },
  {
    name : 'problems-script-up',
    why  : 'Script is up, so the scene row opens it here.',
    state: { diagnostics: DIAGNOSTICS, scenes: SCENES, visible: ['documents', 'script'] },
  },
);
