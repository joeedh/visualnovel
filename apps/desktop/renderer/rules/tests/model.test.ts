import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { duplicateKeys } from '../anchors.js';
import {
  anchoredIds,
  MENU_ROW,
  model,
  pickOffer,
  refusingVerdicts,
  ROWS,
  situationRecords,
} from '../model.js';
import { PALETTE_ONLY } from '../paletteonly.js';
import { menuAnchors } from '../../pathux/doctree/doctree.js';
import {
  paletteMatches,
  UX_MODEL,
  UX_PALETTE_ONLY,
  type UxRecord,
} from '../../../src/shared/uxmodel.js';

const file = model();

describe('model()', () => {
  it('parses under UX_MODEL', () => {
    expect(() => UX_MODEL.parse(file)).not.toThrow();
  });

  it('lists every module in the table, and the menu row', () => {
    const modules = new Set(file.situations.map((s) => s.module));
    for (const row of ROWS) expect(modules.has(row.module)).toBe(true);
    expect(modules.has(MENU_ROW.module)).toBe(true);
    expect(file.situations.length).toBe(ROWS.reduce((n, row) => n + row.situations.length, 0) + 1);
  });

  it('gives no two records in one situation the same key', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        expect(duplicateKeys(row.controls(situation.state))).toEqual([]);
      }
    }
  });

  it('surfaces every refusing verdict in a fixture verbatim', () => {
    const lost: string[] = [];
    for (const row of ROWS) {
      for (const situation of row.situations) {
        const surfaced = new Set(
          situationRecords(row, situation).map((r) =>
            r.offer.ok ? r.offer.tooltip : r.offer.refusal.reason,
          ),
        );
        for (const message of refusingVerdicts(situation.state)) {
          if (!surfaced.has(message)) lost.push(`${row.module}/${situation.name}: ${message}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it('stamps reasonFrom on exactly the refusals worded by the stack', () => {
    for (const row of ROWS) {
      for (const situation of row.situations) {
        const worded = new Set(refusingVerdicts(situation.state));
        for (const record of situationRecords(row, situation)) {
          const fromStack = !record.offer.ok && worded.has(record.offer.refusal.reason);
          expect(record.reasonFrom === 'stack').toBe(fromStack);
        }
      }
    }
  });

  it("matches the doctree's own anchors entry for entry", () => {
    const pair = (r: { when?: string; id: string; form?: boolean }) =>
      `${r.when ?? ''} ${r.id}${r.form ? ' form' : ''}`;
    const derived = file.records
      .filter((r) => r.via === 'menu')
      .map(pair)
      .sort();
    expect(derived).toEqual(menuAnchors().map(pair).sort());
  });

  it('records no field an Offer does not declare', () => {
    const picked = pickOffer({
      id     : 'x.y',
      label  : 'X',
      tooltip: 'Does x.',
      ok     : true,
      props  : { a: 1 },
      note   : 'rider',
    } as never);
    expect(picked).toEqual({
      id     : 'x.y',
      label  : 'X',
      tooltip: 'Does x.',
      ok     : true,
      props  : { a: 1 },
    });
  });
});

describe('ux-model.json', () => {
  const committed = UX_MODEL.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../../../ux-model.json'), 'utf8')),
  );

  // Record by record rather than one deep equality, so a stale file names the first control that
  // moved instead of printing a diff the size of the file.
  it('equals a regeneration (run `pnpm gen:uxmodel` after touching rules/** or a situation)', () => {
    const name = (r: UxRecord | undefined) =>
      r === undefined
        ? '(none)'
        : `${r.module}/${r.situation} ${r.via === 'control' ? r.key : `${r.when} ${r.id}`}`;
    const first = file.records.findIndex(
      (record, i) => JSON.stringify(record) !== JSON.stringify(committed.records[i]),
    );
    const hint = 'differs from model(); run `pnpm gen:uxmodel`';
    if (first >= 0) {
      const fresh = file.records[first];
      const stale = committed.records[first];
      expect({ record: name(fresh), hint, committed: stale }).toEqual({
        record: name(fresh),
        hint,
        committed: fresh,
      });
    }
    expect(committed.records.length).toBe(file.records.length);
    expect(committed.situations).toEqual(file.situations);
    expect(committed.paletteOnly).toEqual(file.paletteOnly);
  });
});

describe('PALETTE_ONLY', () => {
  it('parses entry by entry', () => {
    for (const entry of PALETTE_ONLY) expect(() => UX_PALETTE_ONLY.parse(entry)).not.toThrow();
  });

  it('names no command a control already runs', () => {
    const anchored = anchoredIds(file);
    const overlaps = PALETTE_ONLY.flatMap((entry) =>
      anchored.filter((id) => paletteMatches(entry.match, id)).map((id) => `${entry.match} ${id}`),
    );
    expect(overlaps).toEqual([]);
  });

  it('lists each match once', () => {
    const matches = PALETTE_ONLY.map((entry) => entry.match);
    expect(new Set(matches).size).toBe(matches.length);
  });
});
