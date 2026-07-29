import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Asset, Logger } from '@vn/types';
import { exists, writeFileAtomic } from '@vn/util';
import { loadConfig, setStartScene } from '@vn/config';
import { parseFountain } from '@vn/parse';
import { sceneChunksFromScript, scriptFromScenes, toMermaid } from '@vn/model';
import {
  loadInputs,
  ProjectPaths,
  readSceneChunks,
  writeApprovedPortrait,
  writeSceneChunk,
  writeStoryGraph,
  setCharacterApproval,
} from '@vn/store';
import { buildPlayable, loadSceneShots, writePlayable } from '@vn/export';
import { gateStatus } from '@vn/pipeline';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import { assertValid, buildProviders, loadProject, type LoadedProject } from './project.js';

/** Parsed CLI invocation: positional args + `--flag[=value]` / `-o <value>` options. */
export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Short flags that take the next argument as their value. The table is tiny and lives here on
 * purpose — a short flag not listed is a boolean, which is one rule instead of a parser that
 * guesses from what follows.
 */
const VALUED_SHORT = new Set(['o']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=', 2);
      flags[key!] = value ?? true;
    } else if (arg.length > 1 && arg.startsWith('-')) {
      // `-` alone is length 1, so it is a value (stdout) rather than an empty short flag.
      const [key, value] = arg.slice(1).split('=', 2);
      flags[key!] = value ?? (VALUED_SHORT.has(key!) ? (argv[++i] ?? '') : true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const ok = (s: string): void => void process.stdout.write(s.endsWith('\n') ? s : s + '\n');

function reportDiagnostics(model: {
  diagnostics: { severity: string; code: string; message: string }[];
}): void {
  for (const d of model.diagnostics) {
    ok(`  ${d.severity === 'error' ? '✘' : '⚠'} [${d.code}] ${d.message}`);
  }
}

/** `vngen graph [dir]` — write and print the Mermaid story branch graph (report §6). */
export async function cmdGraph(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  const mermaid = toMermaid(project.model);
  await writeStoryGraph(project.paths, mermaid);
  ok(mermaid);
  return 0;
}

/**
 * `vngen import [dir]` — convert a `screenplay/*.fountain` project into one `scenes/<id>.md`
 * chunk per scene (fountain-import-export plan). One direction, once, and never over authored
 * work: it refuses if `scenes/` already holds chunks, and `sceneChunksFromScript` proves the
 * conversion reads back as the same scenes before a byte of it is written.
 *
 * The screenplay is not deleted — it moves to `<name>.fountain.imported`, an extension
 * `loadInputs` does not look at. That rename is done last, because until it happens the project
 * holds both formats and does not load.
 */
export async function cmdImport(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const paths = new ProjectPaths(dir);
  const config = await loadConfig(dir);

  // An empty `scenes/` has nothing to lose; a chunk in it is either a previous import or work
  // the author wrote by hand, and re-running would silently overwrite the second.
  const already = await readSceneChunks(paths);
  if (already.length > 0) {
    ok(`${paths.scenesDir} already holds ${already.length} scene chunk(s).`);
    ok('Delete the directory if you really want to import over them; there is no --force.');
    return 1;
  }

  const inputs = await loadInputs(paths);
  if (inputs.scriptPath === undefined) {
    ok(`No screenplay to import — expected a .fountain file in ${paths.screenplayDir}.`);
    return 1;
  }
  const asideName = `${inputs.scriptPath}.imported`;
  if (await exists(asideName)) {
    ok(`${asideName} already exists — move or delete it first.`);
    return 1;
  }

  const result = sceneChunksFromScript(
    parseFountain(inputs.scriptText),
    config.start === undefined ? {} : { start: config.start },
  );
  if (result.diagnostics.length) {
    ok(`Reading ${inputs.scriptPath}:`);
    reportDiagnostics(result);
  }
  if (result.diagnostics.some((d) => d.severity === 'error')) {
    ok('Nothing was converted and no file was touched.');
    return 1;
  }

  for (const chunk of result.chunks) await writeSceneChunk(paths, chunk.id, chunk.doc);
  ok(`Wrote ${result.chunks.length} scene chunk(s) → ${paths.scenesDir}`);
  // A directory has no document order, so the entry the screenplay implied has to be written down.
  if (result.entry !== undefined && (await setStartScene(dir, result.entry))) {
    ok(`Set start: ${result.entry} in ${paths.projectConfig}`);
  }
  await fs.rename(inputs.scriptPath, asideName);
  ok(`Moved the screenplay aside → ${asideName} (delete it once you are satisfied).`);
  return 0;
}

/**
 * `vngen screenplay [dir] [-o <file>|-] [--clean]` — project the scenes back into one Fountain
 * screenplay (fountain-import-export plan). The escape hatch that keeps the chunk format from
 * being lock-in: read-only, stale the moment it is written, and no claim to be a mirror.
 *
 * The default output sits at the project root, never in `screenplay/` — a `.fountain` in there
 * is a second source of truth for every scene, which is the error `loadInputs` reports. `--clean`
 * strips the `[[…]]` markers for a human or a screenwriting tool, and takes the scene ids, the
 * branch structure and `nextLineId` with them, so that output cannot be imported back.
 */
export async function cmdScreenplay(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.scenes.size === 0) {
    ok('No scenes to write.');
    return 1;
  }
  if (project.model.diagnostics.some((d) => d.severity === 'error')) {
    ok('Validation (writing anyway — a projection can describe a broken story):');
    reportDiagnostics(project.model);
  }

  const text = scriptFromScenes(project.model, { clean: Boolean(args.flags['clean']) });
  const out = typeof args.flags['o'] === 'string' ? args.flags['o'] : undefined;
  if (out === '-') {
    process.stdout.write(text);
    return 0;
  }

  // Relative to the shell for an explicit `-o`, and to the project for the default.
  const file = out ? resolve(out) : join(dir, 'screenplay.fountain');
  if (dirname(file) === resolve(project.paths.screenplayDir)) {
    ok(`Refusing to write into ${project.paths.screenplayDir} — a screenplay there is a second`);
    ok('source of truth for every scene, which is an error the project will not load past.');
    return 1;
  }
  await writeFileAtomic(file, text);
  ok(`Wrote ${project.model.scenes.size} scene(s) → ${file}`);
  return 0;
}

/**
 * `vngen export [dir]` — project the model + asset store into `vngen/build/story.play.json`,
 * the flattened, ordered playable a runner interprets (runner plan, Part C). Missing assets
 * are omitted (not an error), so a partially-generated — or entirely un-generated — project
 * still exports a playable story graph.
 */
export async function cmdExport(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.some((d) => d.severity === 'error')) {
    ok('Validation (exporting anyway — a runner may hit missing scenes):');
    reportDiagnostics(project.model);
  }
  const shots = await loadSceneShots(project.paths, project.model);
  const playable = buildPlayable(project.model, project.store, shots);
  await writePlayable(project.paths, playable);
  ok(`Exported ${Object.keys(playable.scenes).length} scene(s) → ${project.paths.storyPlay}`);
  return 0;
}

/** `vngen status [dir]` — task/asset/approval summary (report §10). */
export async function cmdStatus(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  const counts: Record<string, number> = {};
  for (const t of project.graph.all()) counts[t.status] = (counts[t.status] ?? 0) + 1;

  ok(`Project: ${project.config.title}`);
  ok(`Scenes: ${project.model.scenes.size} (${project.model.reachable.size} reachable)`);
  ok(`Characters: ${project.model.characters.size}  Locations: ${project.model.locations.size}`);
  ok(`Assets: ${project.store.manifest().length}`);
  ok('Tasks:');
  for (const status of ['pending', 'running', 'done', 'failed', 'needs_human'] as const) {
    if (counts[status]) ok(`  ${status}: ${counts[status]}`);
  }
  const gate = gateStatus(project.model);
  ok(`Gate: ${gate.cleared ? 'cleared' : `awaiting approval — ${gate.pending.join(', ')}`}`);
  return 0;
}

/** Print the planned-work preview from a dry-run summary (shared by `cost` and `run --mock`). */
function printPreview(summary: RunSummary, header: string): void {
  const { preview } = summary;
  ok(header);
  ok(`  pending tasks: ${preview.pendingTasks}`);
  ok(`  image calls:   ${preview.imageCalls}`);
  ok(`  review calls:  ${preview.reviewCalls}`);
  for (const [kind, n] of Object.entries(preview.byKind)) if (n) ok(`    ${kind}: ${n}`);
  ok(
    `Gate: ${summary.gate.cleared ? 'cleared' : `awaiting approval — ${summary.gate.pending.join(', ')}`}`,
  );
}

/** `vngen cost [dir]` — dry-run cost preview without spending (report §10). */
export async function cmdCost(args: Args, logger: Logger): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) reportDiagnostics(project.model);
  assertValid(project.model);
  const providers = await buildProviders(project, { mock: true, logger });
  const summary = await runPipeline({ ...project, providers, dryRun: true, logger });
  printPreview(summary, 'Cost preview (upper bound):');
  return 0;
}

/**
 * `vngen run [dir] [--mock]` — execute to the next gate (report §10). `--mock` is a dry run:
 * it plans, writes the story graph, and previews the work without calling any model or
 * writing assets (no API keys needed). Drop `--mock` to generate for real.
 */
export async function cmdRun(args: Args, logger: Logger): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const mock = Boolean(args.flags['mock']);
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) {
    ok('Validation:');
    reportDiagnostics(project.model);
  }
  assertValid(project.model);

  await writeStoryGraph(project.paths, toMermaid(project.model));
  const providers = await buildProviders(project, { mock, logger });

  const summary = await runPipeline({
    ...project,
    providers,
    dryRun: mock,
    logger,
    now: () => new Date().toISOString(),
  });

  if (mock) {
    printPreview(summary, 'Dry run (--mock) — planned work, nothing generated:');
    return 0;
  }

  ok(`Ran ${summary.ran.length} task(s).`);
  const failed = summary.ran.filter((t) => t.status === 'failed');
  const needsHuman = summary.ran.filter((t) => t.status === 'needs_human');
  if (failed.length) ok(`  failed: ${failed.length}`);
  if (needsHuman.length) ok(`  needs human: ${needsHuman.length}`);
  ok(`Assets in manifest: ${project.store.manifest().length}`);

  if (summary.blockedOnGate) {
    ok('');
    ok('Halted at the character-approval gate. Pending characters:');
    for (const id of summary.gate.pending) {
      ok(`  ${id} — review candidates in ${project.paths.candidatesDir(id)}`);
    }
    ok(`Approve them interactively with: vngen approve${dir === '.' ? '' : ` ${dir}`}`);
  } else {
    ok('Gate cleared — all reachable shots generated.');
  }
  return 0;
}

/** A line-oriented prompt seam so the interactive flow can be driven by tests. */
export interface ApproveIO {
  ask(question: string): Promise<string>;
  write(line: string): void;
}

/** A terminal-backed {@link ApproveIO} over node:readline. */
function terminalIO(): ApproveIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((res) => rl.question(q, (a) => res(a))),
    write: (l) => void process.stdout.write(l.endsWith('\n') ? l : l + '\n'),
    close: () => rl.close(),
  };
}

/** `yes` unless the answer is a clear no; blank takes the default. */
function answeredYes(answer: string, dflt: boolean): boolean {
  const t = answer.trim().toLowerCase();
  if (!t) return dflt;
  return t === 'y' || t === 'yes';
}

/** The character's portrait candidates in the manifest (one per character today). */
function portraitsFor(project: LoadedProject, characterId: string): Asset[] {
  return project.store
    .manifest()
    .filter((a) => a.kind === 'portrait' && a.satisfies.characterId === characterId);
}

/** Flip the character to approved with `hash`, copy the visible portrait, accept the asset. */
async function approveCharacter(
  project: LoadedProject,
  characterId: string,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const flipped = await setCharacterApproval(project.paths, characterId, hash);
  if (!flipped) return { ok: false, message: `No character file for "${characterId}".` };
  const bytes = await project.store.read({ hash, ext: 'png' });
  await writeApprovedPortrait(project.paths, characterId, bytes);
  await project.store.accept(hash);
  return { ok: true, message: `Approved ${characterId} → ${hash}.` };
}

/** Approve one named character (the `--character` path): resolve the hash, then flip it. */
async function approveOne(
  project: LoadedProject,
  characterId: string,
  explicitHash: string | undefined,
  dir: string,
): Promise<number> {
  let hash = explicitHash;
  if (hash) {
    if (!project.store.has(hash)) {
      ok(`No asset with hash "${hash}" in the store.`);
      return 1;
    }
  } else {
    const portraits = portraitsFor(project, characterId);
    if (portraits.length === 0) {
      ok(`No generated portrait for "${characterId}". Run \`vngen run ${dir}\` first.`);
      return 1;
    }
    if (portraits.length > 1) {
      ok(`Multiple portraits for "${characterId}" — pick one with --hash=<assetHash>:`);
      for (const p of portraits) ok(`  ${p.hash}`);
      return 1;
    }
    hash = portraits[0]!.hash;
  }
  const r = await approveCharacter(project, characterId, hash);
  ok(r.ok ? `${r.message} Re-run \`vngen run ${dir}\` to continue past the gate.` : r.message);
  return r.ok ? 0 : 1;
}

/**
 * `vngen approve [dir] [--character=<id>] [--hash=<h>] [--yes]` — pass character portraits
 * through the gate (report §P3). With no `--character`, it walks every character awaiting
 * approval and prompts for each (default: approve the single generated candidate). The hash
 * is auto-resolved from the manifest; `--hash` overrides it for `--character`. `--yes`
 * accepts all defaults without prompting (required when stdin is not a terminal).
 */
export async function cmdApprove(args: Args, ioOverride?: ApproveIO): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  const explicitHash = typeof args.flags['hash'] === 'string' ? args.flags['hash'] : undefined;
  const onlyCharacter =
    typeof args.flags['character'] === 'string' ? args.flags['character'] : undefined;

  if (onlyCharacter) return approveOne(project, onlyCharacter, explicitHash, dir);

  const pending = gateStatus(project.model).pending;
  if (pending.length === 0) {
    ok('Nothing to approve — every character used by a reachable scene is already approved.');
    return 0;
  }

  const autoYes = Boolean(args.flags['yes']);
  const interactive = Boolean(ioOverride) || Boolean(process.stdin.isTTY);
  if (!interactive && !autoYes) {
    ok('Non-interactive stdin. Pass --yes to approve all pending, or --character=<id> for one.');
    return 1;
  }

  const term = ioOverride ? null : terminalIO();
  const io = ioOverride ?? term!;
  let approved = 0;
  let skipped = 0;
  try {
    io.write(`${pending.length} character(s) awaiting approval: ${pending.join(', ')}`);
    for (const id of pending) {
      const portraits = portraitsFor(project, id);
      if (portraits.length === 0) {
        io.write(`• ${id}: no generated portrait yet — run \`vngen run ${dir}\` first. Skipping.`);
        skipped++;
        continue;
      }

      let hash = portraits[0]!.hash;
      if (portraits.length > 1) {
        io.write(`• ${id}: ${portraits.length} candidates —`);
        portraits.forEach((p, i) => io.write(`    ${i + 1}. ${p.hash}`));
        const raw = autoYes
          ? '1'
          : (await io.ask(`  Which candidate? [1-${portraits.length}, default 1]: `)).trim();
        const n = Number(raw || '1');
        if (!Number.isInteger(n) || n < 1 || n > portraits.length) {
          io.write(`  Invalid choice — skipping ${id}.`);
          skipped++;
          continue;
        }
        hash = portraits[n - 1]!.hash;
      }

      const yes = autoYes
        ? true
        : answeredYes(await io.ask(`• Approve ${id} → ${hash.slice(0, 12)}…? [Y/n]: `), true);
      if (!yes) {
        io.write(`  Skipped ${id}.`);
        skipped++;
        continue;
      }
      const r = await approveCharacter(project, id, hash);
      io.write(`  ${r.message}`);
      if (r.ok) approved++;
      else skipped++;
    }
  } finally {
    term?.close();
  }

  io.write(`Approved ${approved} character(s)${skipped ? `, skipped ${skipped}` : ''}.`);
  if (approved)
    io.write(`Re-run \`vngen run${dir === '.' ? '' : ` ${dir}`}\` to continue past the gate.`);
  return 0;
}
