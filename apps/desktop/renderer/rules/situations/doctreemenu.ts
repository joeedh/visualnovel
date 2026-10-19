/**
 * The document tree's menu situations. The first draws one node of each kind with an empty
 * clipboard, so the menu's coverage is total; the rest draw the rows the file acts are on under
 * a Cut clipboard, a Copy clipboard, and with three rows marked, since Paste runs `doc.move` or
 * `doc.copy` depending on the clipboard and a marked row's menu is a different menu.
 */
import { situations } from './situation.js';
import { MENU_NODES, NO_MENU_CONTEXT, type MenuContext } from '../../pathux/doctree/doctree.js';
import type { DocNode } from '../../../src/shared/ipc.js';

export interface DocTreeMenuState {
  nodes: readonly DocNode[];
  ctx: MenuContext;
}

/** The rows Cut, Copy and Paste are drawn on, in both modes, and the Wiki heading. */
const FILE_ROWS: readonly DocNode[] = [
  { id: 'branch:wiki', kind: 'branch', label: 'wiki' },
  { id: 'wikidir:lore', kind: 'wikidir', label: 'lore', path: 'wiki/lore' },
  { id: 'wiki:lore/cafe.md', kind: 'wiki', label: 'Café', path: 'wiki/lore/cafe.md' },
  { id: 'dir:wiki/lore', kind: 'dir', label: 'lore', path: 'wiki/lore' },
  { id: 'file:wiki/lore/cafe.md', kind: 'file', label: 'cafe.md', path: 'wiki/lore/cafe.md' },
];

const CLIPPED = ['wiki/a.md', 'wiki/b.md'];

export const SITUATIONS = situations<DocTreeMenuState>(
  {
    name : 'every-kind',
    why: 'One node of each kind the tree draws, so the menu’s coverage is total rather than a project’s; nothing is on the clipboard, so Paste is refused.',
    state: { nodes: MENU_NODES, ctx: NO_MENU_CONTEXT },
  },
  {
    name : 'cut-clipboard',
    why  : 'Two pages were cut, so Paste on a folder or a file moves them there with doc.move.',
    state: { nodes: FILE_ROWS, ctx: { ...NO_MENU_CONTEXT, clip: { paths: CLIPPED, mode: 'cut' } } },
  },
  {
    name : 'copy-clipboard',
    why  : 'Two pages were copied, so Paste on a folder or a file copies them there with doc.copy.',
    state: {
      nodes: FILE_ROWS,
      ctx  : { ...NO_MENU_CONTEXT, clip: { paths: CLIPPED, mode: 'copy' } },
    },
  },
  {
    name : 'three-marked',
    why: 'Three rows are marked and the menu is raised on the marked folder, so it offers Cut, Copy and Delete of all three and a Paste into that folder.',
    state: {
      nodes: [FILE_ROWS[1]!],
      ctx: {
        clip  : { paths: CLIPPED, mode: 'copy' },
        marked: ['wiki/lore', 'wiki/lore/cafe.md', 'wiki/notes.md'],
        dirty : [],
      },
    },
  },
);
