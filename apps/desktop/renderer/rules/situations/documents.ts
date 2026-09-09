/**
 * The Documents pane's situations: whether a row holds the rename box, and which editors are up
 * when the rows are clicked, since the route a row opens with depends on that.
 */
import { situations } from './situation.js';
import type { DocumentsState, RowState } from '../documents.js';
import type { Selection } from '../selection.js';
import type { DocNode } from '../../../src/shared/ipc.js';

const NONE: Selection = {
  sceneId    : '',
  shotId     : '',
  characterId: '',
  docPath    : '',
  assetHash  : '',
  graphSlug  : '',
};

const row = (node: DocNode, expandable = false, expanded = false): RowState => ({
  node,
  expandable,
  expanded,
});

/** One row of each behaviour: a heading, a scene, a shot, a sheet, an asset and a counted stand-in. */
const ROWS: readonly RowState[] = [
  row({ id: 'branch:story', kind: 'branch', label: 'Story' }, true, true),
  row({ id: 'scene:arrival', kind: 'scene', label: 'arrival', path: 'scenes/arrival.md' }, true),
  row({ id: 'shot:arrival/arrival__s1', kind: 'shot', label: 'arrival__s1', hash: 'a1b2c3d4' }),
  row({
    id   : 'character:aiko',
    kind : 'character',
    label: 'Aiko',
    path : 'characters/aiko/character.md',
  }),
  row({ id: 'location:cafe', kind: 'location', label: 'Café Mori' }),
  row({ id: 'asset:a1b2c3d4', kind: 'asset', label: 'a1b2c3d4', slot: 'plate:cafe/night' }, true),
  row({ id: 'more:assets', kind: 'more', label: '12 more' }, true),
];

export const SITUATIONS = situations<DocumentsState>(
  {
    name : 'idle',
    why  : 'Only the bar is drawn: the mode toggle, New…, Refresh and Close all.',
    state: {},
  },
  {
    name : 'files-mode',
    why: 'The tree is grouped by folder, so the toggle reads FILES and offers the other grouping.',
    state: { mode: 'files' },
  },
  {
    name : 'renaming',
    why  : 'A row holds the rename box, which commits doc.rename on the document it stands in.',
    state: { renaming: { path: 'characters/aiko/character.md', name: 'Aiko' } },
  },
  {
    name : 'rows-claimant-hidden',
    why: 'Only the tree is up, so a row that opens an editor opens it elsewhere; a heading and a stand-in expand.',
    state: { rows: { list: ROWS, selection: NONE, visible: ['documents'] } },
  },
  {
    name : 'rows-claimant-visible',
    why: 'Script and Asset are up, so a scene row and an asset row open here; the selected asset row expands instead.',
    state: {
      rows: {
        list     : ROWS,
        selection: { ...NONE, assetHash: 'a1b2c3d4' },
        visible  : ['documents', 'script', 'asset'],
      },
    },
  },
  {
    name : 'backlinks',
    why: 'A character is picked, so the panel links its sheet, its art, and the scenes and shots it appears in.',
    state: {
      rows : { list: ROWS, selection: { ...NONE, characterId: 'aiko' }, visible: ['documents'] },
      panel: {
        sheet  : { path: 'characters/aiko/character.md', wiki: false },
        assets : [{ hash: 'a1b2c3d4', label: 'Aiko — uniform / front', accepted: true }],
        scenes : ['arrival'],
        shots  : [{ scene: 'arrival', shot: 'arrival__s1' }],
        visible: ['documents'],
      },
    },
  },
);
