/**
 * The desktop registry is loadable without Electron on purpose: the command modules reach
 * the session only through a type-only import, so the build-time catalog generator (and this
 * test) can construct the registry in a plain Node process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_ID } from '@vn/commands';
import { catalog } from '../catalog-entry.js';
import { desktopInteractions } from '../interaction.js';
import { createDesktopRegistry } from '../index.js';

const GENERATED = join(__dirname, '..', '..', '..', '..', 'dist', 'commands.json');

describe('the desktop registry', () => {
  const commands = createDesktopRegistry().list();

  it('registers every namespace the UI reaches', () => {
    expect(createDesktopRegistry().namespaces()).toEqual([
      'agent',
      'gate',
      'interaction',
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

  it('marks the file-writing commands mutating', () => {
    const mutating = commands.filter((c) => c.mutating).map((c) => c.id);
    expect(mutating).toEqual([
      'agent.run',
      'gate.approve',
      'pipeline.run',
      'story.export',
      'story.removeChoice',
      'story.setChoice',
      'story.setCoverage',
      'story.setNext',
      'story.spliceScene',
    ]);
  });

  /**
   * Undo restores a snapshot of the *document* tree, so only commands whose writes are
   * documents may opt in. The rest write generated output (`story.export`), append to a log
   * (`pipeline.run`), or straddle both classes (`gate.approve` flips `character.md` **and**
   * marks the asset accepted in `manifest.json`) — see `docs/plans/command-undo-redo.md`.
   */
  it('opts only the document writers into undo, and nothing non-mutating', () => {
    expect(commands.filter((c) => c.undoable).map((c) => c.id)).toEqual([
      'story.removeChoice',
      'story.setChoice',
      'story.setCoverage',
      'story.setNext',
      'story.spliceScene',
    ]);
    expect(commands.filter((c) => c.undoable && !c.mutating)).toEqual([]);
  });

  it('projects to a catalog with a usage template and a schema per command', () => {
    for (const entry of catalog().commands) {
      expect(entry.usage).toMatch(/^[a-z][\w.]*\(.*\)$/);
      expect(entry.schema.type).toBe('object');
      expect(entry.schema.additionalProperties).toBe(false);
    }
  });

  /**
   * The one guarantee that keeps the gesture surface and the command surface from becoming two
   * truths about what the app can do. `catalog()` runs it too, so a bad build fails; this says
   * so out loud, and pins the interactions that ship.
   */
  it('terminates every interaction in a command that exists', () => {
    expect(() => desktopInteractions.verify(createDesktopRegistry())).not.toThrow();
    expect(catalog().interactions?.map((i) => i.id)).toEqual([
      'branch.connect',
      'branch.splice',
      'branch.unwire',
    ]);
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
    expect(JSON.parse(generated!)).toEqual(catalog());
  });
});
