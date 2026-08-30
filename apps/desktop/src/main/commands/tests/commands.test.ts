/**
 * The desktop registry is loadable without Electron on purpose: the command modules reach
 * the session only through a type-only import, so the build-time catalog generator (and this
 * test) can construct the registry in a plain Node process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_ID } from '@vn/commands';
import { catalog, catalogOf } from '../catalog-entry.js';
import { docIndex } from '../doc-entry.js';
import { desktopInteractions } from '../interaction.js';
import { createDesktopRegistry } from '../index.js';

const GENERATED = join(__dirname, '..', '..', '..', '..', 'dist', 'commands.json');

describe('the desktop registry', () => {
  const commands = createDesktopRegistry().list();

  it('registers every namespace the UI reaches', () => {
    expect(createDesktopRegistry().namespaces()).toEqual([
      'agent',
      'app',
      'art',
      'asset',
      'bible',
      'command',
      'doc',
      'gate',
      'gengraph',
      'interaction',
      'notify',
      'pipeline',
      'plugin',
      'project',
      'prompt',
      'report',
      'story',
      'upload',
      'view',
      'window',
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
      'agent.compact',
      'agent.renameThread',
      'agent.run',
      'art.generate',
      'art.promote',
      'art.redraw',
      'art.setNotes',
      'art.setSeed',
      'asset.accept',
      'asset.adopt',
      'asset.regenerate',
      'asset.replace',
      'asset.restore',
      'asset.unapprove',
      'asset.upload',
      'doc.create',
      'doc.rename',
      'doc.write',
      'gate.approve',
      'gengraph.addNode',
      'gengraph.apply',
      'gengraph.create',
      'gengraph.createForSlot',
      'gengraph.delete',
      'gengraph.duplicateNode',
      'gengraph.link',
      'gengraph.moveNodes',
      'gengraph.removeNode',
      'gengraph.run',
      'gengraph.setActiveOutput',
      'gengraph.setProp',
      'gengraph.unlink',
      'notify.deleteAll',
      'pipeline.approveAndRun',
      'pipeline.run',
      'plugin.install',
      'plugin.prices',
      'plugin.remove',
      'project.installPages',
      'project.setArtStyle',
      'project.setKey',
      'prompt.addRef',
      'prompt.clear',
      'prompt.condense',
      'prompt.dropRef',
      'prompt.moveChunk',
      'prompt.repin',
      'prompt.setChunk',
      'prompt.setCustom',
      'story.assignLineIds',
      'story.decomposeAll',
      'story.deleteLine',
      'story.deleteScene',
      'story.deleteShot',
      'story.export',
      'story.insertLine',
      'story.mergeScene',
      'story.moveLine',
      'story.moveShot',
      'story.newScene',
      'story.newShot',
      'story.removeChoice',
      'story.screenplay',
      'story.setChoice',
      'story.setCoverage',
      'story.setHeading',
      'story.setLineText',
      'story.setNext',
      'story.setOutfit',
      'story.setSceneOutfit',
      'story.setSpeaker',
      'story.setVariant',
      'story.spliceScene',
      'story.splitScene',
      'upload.files',
      'upload.pick',
      'view.resetLayout',
      'view.saveLayout',
      'workspace.create',
      'workspace.import',
      'workspace.open',
      'workspace.pick',
      'workspace.reindex',
    ]);
  });

  /**
   * Undo restores a snapshot of the document tree, so only commands whose writes are documents may
   * opt in. The rest write generated output (`story.export`, `story.screenplay`,
   * `workspace.reindex`, `asset.accept`), write new content-addressed bytes there was no prior
   * state for (`art.generate`, `art.redraw`, `asset.upload`), append to a log (`pipeline.run`,
   * `asset.regenerate`), straddle a sheet, the manifest and the task log at once (`art.promote`,
   * and `asset.adopt`/`asset.replace`, which append a `done` record the log has no un-appending
   * for), restructure the whole worktree (`workspace.import`, whose own `.imported` rename is the
   * reversal), write into a different tree than the one a snapshot covers
   * (`workspace.open`/`pick`/`create`), copy bytes in from outside the tree and close the
   * conversation a snapshot cannot restore (`upload.*`), write under `vngen/state`, which the
   * snapshot deliberately excludes (`agent.renameThread` and `agent.compact` — a transcript must
   * survive undoing the edits it produced), write a credential to a gitignored file (`project.setKey`: an undo point is
   * a git snapshot, and snapshotting a key is the one thing that command exists to avoid), or
   * straddle both classes (`gate.approve` flips `character.md` and marks the asset accepted in
   * `manifest.json`) — see `docs/plans/archive/INDEX.md#command-undo-redo`.
   *
   * `view.saveLayout` and `view.resetLayout` are the exception that proves the rule: a layout
   * template is not a document, but it is an authored file inside the snapshot's pathspec, so undo
   * restores it exactly the way it restores a scene. A generation graph is the same shape: the
   * document at `vngen/work/graphs/` is authored and undoable, while `gengraph.run` is not,
   * because what it writes is a journal record and a blob under `vngen/state`.
   */
  it('opts only the document writers into undo, and nothing non-mutating', () => {
    expect(commands.filter((c) => c.undoable).map((c) => c.id)).toEqual([
      'art.setNotes',
      'art.setSeed',
      'doc.create',
      'doc.rename',
      'doc.write',
      'gengraph.addNode',
      'gengraph.apply',
      'gengraph.create',
      'gengraph.createForSlot',
      'gengraph.delete',
      'gengraph.duplicateNode',
      'gengraph.link',
      'gengraph.moveNodes',
      'gengraph.removeNode',
      'gengraph.setActiveOutput',
      'gengraph.setProp',
      'gengraph.unlink',
      'project.setArtStyle',
      'prompt.addRef',
      'prompt.clear',
      'prompt.condense',
      'prompt.dropRef',
      'prompt.moveChunk',
      'prompt.repin',
      'prompt.setChunk',
      'prompt.setCustom',
      'story.assignLineIds',
      'story.decomposeAll',
      'story.deleteLine',
      'story.deleteScene',
      'story.deleteShot',
      'story.insertLine',
      'story.mergeScene',
      'story.moveLine',
      'story.moveShot',
      'story.newScene',
      'story.newShot',
      'story.removeChoice',
      'story.setChoice',
      'story.setCoverage',
      'story.setHeading',
      'story.setLineText',
      'story.setNext',
      'story.setOutfit',
      'story.setSceneOutfit',
      'story.setSpeaker',
      'story.setVariant',
      'story.spliceScene',
      'story.splitScene',
      'view.resetLayout',
      'view.saveLayout',
    ]);
    expect(commands.filter((c) => c.undoable && !c.mutating)).toEqual([]);
  });

  /**
   * A check is a precondition on an act — something with a cost that running it would incur.
   * That is usually a write, so it is usually a mutator; `agent.run` is the one mutator without
   * one, because what it would do is decided by a model rather than by state this process can
   * read.
   *
   * A handful of non-mutators declare one anyway, and each is an act with a cost that is not a
   * write. The `report.*` commands put nothing in the project, but three of them spend a real
   * model's time on a real key and one opens a public issue tracker on text — so "run it and find
   * out" is the wrong answer to any of them. `report.grant` spends nothing itself and widens what
   * the next turn reads, and its refusals are the tooltips on the two boxes that offer it.
   * `project.testKey` is the same shape and cheaper: it calls a provider for real, so whether a key
   * even resolves is worth answering first. The three stops are the converse: they interrupt an act
   * rather than performing one, so there is state to read — whether a run, a turn or a report is in
   * progress — and the answer is what greys the Stop button and says why.
   */
  it('declares a precondition on what an act would cost, and on the three interrupters', () => {
    expect(commands.filter((c) => c.check).map((c) => c.id)).toEqual([
      'agent.compact',
      'agent.editLine',
      'agent.fixAsset',
      'agent.renameThread',
      'agent.resumeThread',
      'agent.stop',
      'art.generate',
      'art.promote',
      'art.redraw',
      'art.setNotes',
      'art.setSeed',
      'asset.accept',
      'asset.adopt',
      'asset.regenerate',
      'asset.replace',
      'asset.restore',
      'asset.unapprove',
      'asset.upload',
      'doc.create',
      'doc.rename',
      'doc.write',
      'gate.approve',
      'gengraph.addNode',
      'gengraph.apply',
      'gengraph.create',
      'gengraph.createForSlot',
      'gengraph.delete',
      'gengraph.duplicateNode',
      'gengraph.link',
      'gengraph.moveNodes',
      'gengraph.removeNode',
      'gengraph.run',
      'gengraph.setActiveOutput',
      'gengraph.setProp',
      'gengraph.unlink',
      'notify.deleteAll',
      'pipeline.approveAndRun',
      'pipeline.run',
      'pipeline.stop',
      'plugin.install',
      'plugin.prices',
      'plugin.remove',
      'project.installPages',
      'project.setArtStyle',
      'project.setKey',
      'project.testKey',
      'prompt.addRef',
      'prompt.clear',
      'prompt.condense',
      'prompt.dropRef',
      'prompt.moveChunk',
      'prompt.repin',
      'prompt.setChunk',
      'prompt.setCustom',
      'report.agent',
      'report.grant',
      'report.open',
      'report.openIssue',
      'report.say',
      'report.stop',
      'story.assignLineIds',
      'story.decomposeAll',
      'story.deleteLine',
      'story.deleteScene',
      'story.deleteShot',
      'story.export',
      'story.insertLine',
      'story.mergeScene',
      'story.moveLine',
      'story.moveShot',
      'story.newScene',
      'story.newShot',
      'story.removeChoice',
      'story.screenplay',
      'story.setChoice',
      'story.setCoverage',
      'story.setHeading',
      'story.setLineText',
      'story.setNext',
      'story.setOutfit',
      'story.setSceneOutfit',
      'story.setSpeaker',
      'story.setVariant',
      'story.spliceScene',
      'story.splitScene',
      'upload.files',
      'upload.pick',
      'view.resetLayout',
      'view.saveLayout',
      // window.close and window.quit write nothing. Each describes what pressing it costs: one window for window.close, all of them for window.quit.
      'window.close',
      'window.quit',
      'workspace.create',
      'workspace.import',
      'workspace.open',
      'workspace.pick',
      'workspace.reindex',
    ]);
    // A checked non-mutator is the exception, so it is listed by name rather than allowed by rule.
    expect(commands.filter((c) => c.check && !c.mutating).map((c) => c.id)).toEqual([
      // Neither sends a turn nor writes anything. Both are offered from a surface that draws a
      // refusal rather than hiding it, so the sentence for a line the scene has lost, a picture
      // that never failed, or a turn already running has to exist before the click.
      'agent.editLine',
      'agent.fixAsset',
      // Hands the agent a stored conversation and writes nothing. A conversation recorded through
      // another vendor cannot be continued at all, so the Continue button is greyed with the
      // sentence saying which vendor it wants.
      'agent.resumeThread',
      'agent.stop',
      'pipeline.stop',
      // Writes nothing and calls a provider, which is the cost. The Setup pane's Test button is
      // grey until a key resolves, and this is the sentence it shows for why.
      'project.testKey',
      'report.agent',
      'report.grant',
      'report.open',
      'report.openIssue',
      'report.say',
      'report.stop',
      // A window writes nothing, but closing one is not free either: the tooltip on a disabled
      // or last-window control is this check's sentence, so both declare one.
      'window.close',
      'window.quit',
    ]);
  });

  it('projects to a catalog with a usage template and a schema per command', () => {
    for (const entry of catalog().commands) {
      expect(entry.usage).toMatch(/^[a-z][\w.]*\(.*\)$/);
      expect(entry.schema.type).toBe('object');
      expect(entry.schema.additionalProperties).toBe(false);
    }
  });

  /**
   * `notes` is documentation-only design prose, never a tooltip fallback. `command:catalog`
   * serves this projection to the renderer, so a leaked `notes` key would be one accidental
   * property read away from becoming a UI default.
   */
  it("never carries a command's doc notes into the runtime catalog", () => {
    for (const entry of catalog().commands) {
      expect(entry).not.toHaveProperty('notes');
    }
  });

  it('carries doc notes and a namespace in the doc-only index instead', () => {
    const entries = docIndex();
    expect(entries).toHaveLength(commands.length);
    const gateApprove = entries.find((e) => e.id === 'gate.approve');
    expect(gateApprove?.namespace).toBe('gate');
    expect(gateApprove?.notes).toBe('Flips `character.md`; writes the approved PNG + manifest.');
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
      'prompt.reorder',
      'script.moveLine',
      'timeline.cover',
      'timeline.create',
      'timeline.reorder',
    ]);
  });
});

/**
 * The `command:catalog` channel projects through `catalogOf`, so what it serves is what the
 * generator writes. It used to call `toCatalog` itself and drifted — the channel claimed the app
 * had no gestures while `commands.json` listed five — which is what this pins.
 */
describe('the live catalog', () => {
  it('is the same projection the generator writes', () => {
    expect(catalogOf(createDesktopRegistry())).toEqual(catalog());
  });

  it('carries the interactions, which an agent asking what it can do needs', () => {
    expect(catalogOf(createDesktopRegistry()).interactions?.length).toBe(
      desktopInteractions.list().length,
    );
  });
});

/**
 * The channel serves the live registry, so a stale `commands.json` can never mislead the app
 * itself — but it can mislead external tooling, which is what this catches. Skipped when the file
 * hasn't been generated (a check-only checkout).
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
