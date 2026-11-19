/**
 * The takes an export refuses over: every current frame and cast portrait nobody has approved,
 * across every scene the playable carries.
 */
import type { Asset, ProjectModel, Shot } from '@vn/types';
import { parseFountain, parseFrontMatter } from '@vn/parse';
import { buildModel } from '@vn/model';
import { SCRIPTS } from '@vn/testkit';
import { unapprovedTakes } from '../unapproved.js';

const asset = (partial: Partial<Asset> & Pick<Asset, 'hash' | 'kind'>): Asset => ({
  ext       : 'png',
  sourceTask: 'task',
  refs      : [],
  modelId   : 'mock',
  satisfies : [],
  accepted  : true,
  current   : true,
  ...partial,
});

const charDoc = (id: string, name: string) => {
  const text = `---\nid: ${id}\nname: ${name}\n---\n\n${name}.\n`;
  return { id, file: `/p/characters/${id}/character.md`, doc: parseFrontMatter(text), text };
};

/** The branching sample `@vn/export`'s tests build: Aiko and Haruki over four scenes. */
function sampleModel(): ProjectModel {
  return buildModel({
    title        : 'The Transfer Student',
    characterDocs: [charDoc('aiko', 'Aiko'), charDoc('haruki', 'Haruki')],
    locationDocs : [],
    script       : parseFountain(SCRIPTS.branching),
  });
}

describe('unapprovedTakes', () => {
  const base = sampleModel();
  const lines = base.scenes.get('arrival')!.lines.map((l) => l.id);
  const shot: Shot = {
    id         : 'arrival__s1',
    sceneId    : 'arrival',
    framing    : 'wide',
    location   : 'evening',
    subjects   : [],
    coversLines: lines,
  };
  const model: ProjectModel = { ...base, production: new Map([['arrival', { shots: [shot] }]]) };
  const frame = (over: Partial<Asset>): Asset =>
    asset({
      hash     : 'f1',
      kind     : 'shot_image',
      satisfies: [{ sceneId: 'arrival', shotId: 'arrival__s1' }],
      ...over,
    });
  const portrait = (over: Partial<Asset>): Asset =>
    asset({ hash: 'p1', kind: 'portrait', satisfies: [{ characterId: 'aiko' }], ...over });

  it('lists the frames and cast portraits the playable would show unapproved, frames first', () => {
    const assets = [frame({ accepted: false }), portrait({ accepted: false })];
    expect(unapprovedTakes(model, assets)).toEqual([
      { slot: 'shot:arrival/arrival__s1', hash: 'f1' },
      { slot: 'portrait:aiko', hash: 'p1' },
    ]);
  });

  it('is silent for approved takes, and for a slot that holds nothing', () => {
    // A frame a later render pushed out is history and not shown, so its flag does not matter.
    const assets = [
      frame({ accepted: true }),
      frame({ hash: 'f0', current: false, accepted: false }),
      portrait({ accepted: true }),
    ];
    expect(unapprovedTakes(model, assets)).toEqual([]);
    // Nothing drawn at all: the player shows a placeholder, and there is nothing to approve.
    expect(unapprovedTakes(model, [])).toEqual([]);
  });

  it('reads a portrait off its row, as the gate does; the sheet alone approves nothing', () => {
    const sheetOnly: ProjectModel = {
      ...model,
      characters: new Map(
        [...model.characters].map(([id, c]) =>
          id === 'aiko' ? [id, { ...c, status: 'approved', approvedPortrait: 'p1' }] : [id, c],
        ),
      ),
    };
    const assets = [portrait({ accepted: false })];
    expect(unapprovedTakes(sheetOnly, assets)).toEqual([{ slot: 'portrait:aiko', hash: 'p1' }]);
    // A locked character's approval is the sheet's, whatever the slot holds
    const locked: ProjectModel = {
      ...model,
      characters: new Map(
        [...model.characters].map(([id, c]) =>
          id === 'aiko' ? [id, { ...c, status: 'locked', approvedPortrait: 'p1' }] : [id, c],
        ),
      ),
    };
    expect(unapprovedTakes(locked, assets)).toEqual([]);
  });
});
