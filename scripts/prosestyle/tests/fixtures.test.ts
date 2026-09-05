import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseFixtures } from '../fixtures.js';
import { assertedRules, ruleDescription, stillViolates } from '../grade.js';

const DIR = join(__dirname, '..', 'fixtures');

describe('parseFixtures', () => {
  it('keeps a body that contains Markdown the delimiter must not be confused with', () => {
    const parsed = parseFixtures(
      ['=== id: a', '=== rule: r', '- a bullet', '', '```', 'code', '```', '=== end'].join('\n'),
    );
    expect(parsed).toEqual([{ id: 'a', rule: 'r', body: '- a bullet\n\n```\ncode\n```' }]);
  });

  it('ignores a preamble before the first fixture', () => {
    expect(parseFixtures('notes about the set\n\n=== id: a\nbody\n=== end')).toHaveLength(1);
  });

  it('refuses a fixture that was never closed', () => {
    expect(() => parseFixtures('=== id: a\nbody')).toThrow(/no === end/);
  });
});

describe('the fixture sets on disk', () => {
  it('gives every violation a rule the judge can describe', async () => {
    const text = await fs.readFile(join(DIR, 'violations.txt'), 'utf8');
    const fixtures = parseFixtures(text);
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    for (const f of fixtures) {
      expect(f.rule).toBeDefined();
      expect(() => ruleDescription(f.rule as string)).not.toThrow();
    }
  });

  it('has unique ids across every set', async () => {
    const ids: string[] = [];
    for (const name of ['violations.txt', 'conforming.txt', 'context.txt']) {
      const text = await fs.readFile(join(DIR, name), 'utf8');
      ids.push(...parseFixtures(text).map((f) => f.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * An assertion that cannot find the violation in the unrevised fixture would score every
   * revision as fixed, which is the failure mode that reports a working prompt when there is
   * none.
   */
  it('finds every asserted violation in the unrevised text', async () => {
    const text = await fs.readFile(join(DIR, 'violations.txt'), 'utf8');
    const covered = new Set(assertedRules());
    const checked = parseFixtures(text).filter((f) => covered.has(f.rule as string));
    expect(checked.length).toBeGreaterThan(0);
    for (const f of checked) {
      expect([f.id, stillViolates(f.rule as string, f.body)]).toEqual([f.id, true]);
    }
  });

  it('finds no asserted violation in the conforming set', async () => {
    const text = await fs.readFile(join(DIR, 'conforming.txt'), 'utf8');
    for (const f of parseFixtures(text)) {
      for (const rule of assertedRules()) {
        expect([f.id, rule, stillViolates(rule, f.body)]).toEqual([f.id, rule, false]);
      }
    }
  });
});
