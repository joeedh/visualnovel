/**
 * The desktop registry is loadable without Electron on purpose: the command modules reach
 * the session only through a type-only import, so the build-time catalog generator (and this
 * test) can construct the registry in a plain Node process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_ID, toCatalog } from '@vn/commands';
import { catalog } from './catalog-entry.js';
import { createDesktopRegistry } from './index.js';

const GENERATED = join(__dirname, '..', '..', '..', 'dist', 'commands.json');

describe('the desktop registry', () => {
  const commands = createDesktopRegistry().list();

  it('registers every namespace the UI reaches', () => {
    expect(createDesktopRegistry().namespaces()).toEqual([
      'agent',
      'gate',
      'pipeline',
      'story',
      'view',
      'workspace',
    ]);
  });

  it('gives every command a well-formed id, a title and a description', () => {
    for (const command of commands) {
      expect(command.id).toMatch(COMMAND_ID);
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it('describes every property, so the catalog and a future panel can render them', () => {
    for (const command of commands) {
      for (const [name, spec] of Object.entries(command.props)) {
        expect(`${command.id}.${name}: ${spec.description}`).not.toMatch(/: $/);
        if (spec.kind === 'enum') expect(spec.values?.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks the file-writing commands mutating and nothing undoable in v1', () => {
    const mutating = commands.filter((c) => c.mutating).map((c) => c.id);
    expect(mutating).toEqual(['agent.run', 'gate.approve', 'pipeline.run', 'story.export']);
    expect(commands.filter((c) => c.undoable)).toEqual([]);
  });

  it('projects to a catalog with a usage template and a schema per command', () => {
    for (const entry of catalog().commands) {
      expect(entry.usage).toMatch(/^[a-z][\w.]*\(.*\)$/);
      expect(entry.schema.type).toBe('object');
      expect(entry.schema.additionalProperties).toBe(false);
    }
  });
});

/**
 * The `command:catalog` channel serves the live registry, so a stale `commands.json` can
 * never mislead the app itself — but it can mislead external tooling, which is what this
 * catches. Skipped when the file hasn't been generated (a check-only checkout).
 */
describe('the generated commands.json', () => {
  let generated: string | undefined;
  try {
    generated = readFileSync(GENERATED, 'utf8');
  } catch {
    generated = undefined;
  }

  (generated ? it : it.skip)('matches the live registry', () => {
    expect(JSON.parse(generated!)).toEqual(toCatalog(createDesktopRegistry(), '@vn/desktop'));
  });
});
