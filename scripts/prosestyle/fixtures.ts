/**
 * The fixture file format and its parser.
 *
 * A fixture's body is Markdown that may itself contain fences, headings and bullets, so the
 * delimiter is a line-anchored `=== ` that no Markdown construct produces.
 *
 *   === id: metaphor-01
 *   === rule: metaphorical-equation
 *   The leak scan is the refusal.
 *   === end
 */
import { promises as fs } from 'node:fs';

export interface Fixture {
  id: string;
  /** The rule the block breaks, for the violation set. Absent on conforming blocks. */
  rule?: string;
  /** Where the block came from, so a reader can check the judgement that filed it. */
  source?: string;
  body: string;
}

const HEAD = /^=== (id|rule|source): (.*)$/;

export function parseFixtures(text: string): Fixture[] {
  const out: Fixture[] = [];
  let current: Partial<Fixture> | undefined;
  let body: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const head = HEAD.exec(line);
    if (head) {
      const key = head[1] as 'id' | 'rule' | 'source';
      const value = (head[2] ?? '').trim();
      if (key === 'id') {
        if (current) throw new Error(`fixture ${current.id} has no === end`);
        current = { id: value };
        body = [];
      } else {
        if (!current) throw new Error(`=== ${key} before any === id`);
        current[key] = value;
      }
      continue;
    }
    if (line === '=== end') {
      if (!current) throw new Error('=== end before any === id');
      out.push({ ...(current as Fixture), body: body.join('\n').trim() });
      current = undefined;
      continue;
    }
    if (current) body.push(line);
  }
  if (current) throw new Error(`fixture ${current.id} has no === end`);
  return out;
}

export async function loadFixtures(path: string): Promise<Fixture[]> {
  return parseFixtures(await fs.readFile(path, 'utf8'));
}
