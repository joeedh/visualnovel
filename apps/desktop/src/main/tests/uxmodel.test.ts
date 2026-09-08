/**
 * The coverage rule over the derived model (`docs/reference/guided-tours.md`, Part III): every
 * command the registry lists is either the `id` of some record in `apps/desktop/ux-model.json` or
 * matches a `paletteOnly` entry, and every entry earns its place by matching a command no record
 * names. The file is read as JSON, never derived here, so this test needs nothing from the renderer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDesktopRegistry } from '../commands/index.js';
import { paletteMatches, UX_MODEL } from '../../shared/uxmodel.js';

const model = UX_MODEL.parse(
  JSON.parse(readFileSync(resolve(__dirname, '../../../ux-model.json'), 'utf8')),
);

const live = createDesktopRegistry()
  .list()
  .map((command) => command.id)
  .sort();

const anchored = new Set(
  model.records.map((record) => (record.via === 'control' ? record.offer.id : record.id)),
);

const listed = (id: string) => model.paletteOnly.some((entry) => paletteMatches(entry.match, id));

interface SweptRecord {
  id: string;
  editor: string;
  key?: string;
  when?: string;
  supplies?: string[];
  form?: boolean;
  refused?: string;
}

const sweep = JSON.parse(readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8')) as {
  records: SweptRecord[];
};

describe('ux-model.json against the registry', () => {
  it('names only commands that exist', () => {
    expect([...anchored].filter((id) => !live.includes(id)).sort()).toEqual([]);
  });

  it('gives every command a control or a reason', () => {
    const uncovered = live.filter((id) => !anchored.has(id) && !listed(id));
    expect(uncovered).toEqual([]);
  });

  it('lists no command a control already runs', () => {
    const both = live.filter((id) => anchored.has(id) && listed(id));
    expect(both).toEqual([]);
  });

  it('keeps no palette-only entry that matches nothing', () => {
    const dead = model.paletteOnly
      .filter((entry) => !live.some((id) => !anchored.has(id) && paletteMatches(entry.match, id)))
      .map((entry) => entry.match);
    expect(dead).toEqual([]);
  });
});

/**
 * One direction only: what the sweep drew, the situations must list. The other direction is not
 * a rule, because a situation can describe a state the swept project never reached.
 */
describe('ux-model.json against anchors.json', () => {
  const controls = model.records.filter((r) => r.via === 'control');
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  it('lists every control the sweep drew, with the same form and supplies', () => {
    const unlisted = sweep.records
      .filter((swept) => swept.key !== undefined)
      .filter(
        (swept) =>
          !controls.some(
            (record) =>
              record.editor === swept.editor &&
              record.offer.id === swept.id &&
              (swept.form === undefined || record.offer.form === swept.form) &&
              (swept.supplies === undefined || same(record.offer.supplies, swept.supplies)),
          ),
      )
      .map((swept) => `${swept.editor} ${swept.key}`);
    expect(unlisted).toEqual([]);
  });

  it('lists the same menu entries as the sweep, entry for entry', () => {
    const pair = (r: { when?: string; id: string }) => `${r.when ?? ''} ${r.id}`;
    const derived = model.records
      .filter((r) => r.via === 'menu')
      .map(pair)
      .sort();
    const swept = sweep.records
      .filter((r) => r.key === undefined)
      .map(pair)
      .sort();
    expect(derived).toEqual(swept);
  });
});
