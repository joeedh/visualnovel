import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { AnyTask, Asset, Logger, Providers } from '@vn/types';
import { bindsTo } from '@vn/types';
import { exists, readText, writeFileAtomic } from '@vn/util';
import { loadConfig, setStartScene } from '@vn/config';
import { parseFountain } from '@vn/parse';
import { sceneChunksFromScript, scriptFromScenes, toMermaid } from '@vn/model';
import {
  entityFile,
  findScreenplay,
  ProjectPaths,
  readSceneChunks,
  writeApprovedPortrait,
  writeSceneChunk,
  writeStoryGraph,
  setCharacterApproval,
} from '@vn/store';
import { buildPlayable, loadSceneShots, writePlayable } from '@vn/export';
import {
  decomposeAll,
  gateStatus,
  graphRuntime,
  priceSlots,
  readProjectGraphs,
  reportGraphs,
  suspendedAssets,
  unrenderedBoundSlots,
  type GraphDoc,
  type GraphRuntime,
} from '@vn/pipeline';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import {
  assertValid,
  buildGenDeps,
  buildProviders,
  loadProject,
  type GenDeps,
  type LoadedProject,
} from './project.js';

/** Parsed CLI invocation: positional args + `--flag[=value]` / `-o <value>` options. */
export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Short flags that take the next argument as their value. A short flag not listed here is a
 * boolean.
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

/** How many failure reasons `run` and `status` spell out before summarizing the rest. */
const FAILURES_SHOWN = 5;

/** Run-level attempts already spent on a task — only the records that carry a reason. */
const spentAttempts = (task: AnyTask): number => task.attempts.filter((a) => a.error).length;

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
 * chunk per scene (fountain-import-export plan). The conversion runs in one direction, once, and
 * never over authored work: it refuses if `scenes/` already holds chunks, and
 * `sceneChunksFromScript` proves the conversion reads back as the same scenes before a byte of it
 * is written.
 *
 * The screenplay is not deleted. It moves to `<name>.fountain.imported`, an extension `loadInputs`
 * does not look at, and that rename is done last because until it happens the project still
 * reports the screenplay on every load.
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

  // The same finder `loadInputs` uses to report the leftover, so the file complained about is
  // the file converted — the reader and the importer cannot disagree about which one it is.
  const scriptPath = await findScreenplay(paths);
  if (scriptPath === undefined) {
    ok(`No screenplay to import — expected a .fountain file in ${paths.screenplayDir}.`);
    return 1;
  }
  const asideName = `${scriptPath}.imported`;
  if (await exists(asideName)) {
    ok(`${asideName} already exists — move or delete it first.`);
    return 1;
  }

  const result = sceneChunksFromScript(
    parseFountain(await readText(scriptPath)),
    config.start === undefined ? {} : { start: config.start },
  );
  if (result.diagnostics.length) {
    ok(`Reading ${scriptPath}:`);
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
  await fs.rename(scriptPath, asideName);
  ok(`Moved the screenplay aside → ${asideName} (delete it once you are satisfied).`);
  return 0;
}

/**
 * `vngen screenplay [dir] [-o <file>|-] [--clean]` — project the scenes back into one Fountain
 * screenplay (fountain-import-export plan). This keeps the chunk format from being lock-in; the
 * output is read-only, is stale the moment it is written, and is not a mirror of the scenes.
 *
 * The default output sits at the project root, never in `screenplay/` — a `.fountain` in there is
 * the retired one-file form, which `loadInputs` reports for as long as it exists. `--clean`
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
    ok(`Refusing to write into ${project.paths.screenplayDir} — a .fountain there is read as the`);
    ok('retired one-file form, and the project would report it on every load from now on.');
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
  const playable = buildPlayable(project.model, project.store, {
    shots,
    portraitOverlay: project.config.portrait_overlay,
  });
  await writePlayable(project.paths, playable);
  ok(`Exported ${Object.keys(playable.scenes).length} scene(s) → ${project.paths.storyPlay}`);
  if (playable.portraitOverlay) {
    ok('Portrait overlay is on — a runner draws the speaker over the shot image.');
  }
  return 0;
}

/**
 * The graphs the project holds, and the output nodes whose graph has been edited since they
 * last ran. Drift is reported rather than acted on, the posture a prose edit already takes:
 * a drifted node keeps the picture it drew until someone asks for another one.
 */
async function printGraphStatus(project: LoadedProject): Promise<void> {
  const { docs, problems } = await readProjectGraphs(project.dir, project.paths);
  for (const problem of problems) ok(`Graph not loaded — ${problem}`);
  if (docs.length === 0) return;

  const report = reportGraphs(docs, { maxRefineAttempts: project.config.max_refine_attempts });
  ok(`Generation graphs: ${docs.length} (${report.bound.size} slot(s) bound)`);
  for (const slot of report.conflicts) {
    ok(`  ${slot}: more than one active output claims it, so no graph draws it`);
  }
  for (const drift of report.drifted.slice(0, FAILURES_SHOWN)) {
    const slot = drift.slot ? ` (${drift.slot})` : '';
    ok(`  drifted: ${drift.slug} node ${String(drift.nodeId)}${slot} — edited since it last ran`);
  }
  if (report.drifted.length > FAILURES_SHOWN) {
    ok(`  … and ${report.drifted.length - FAILURES_SHOWN} more drifted`);
  }
}

/**
 * `vngen status [dir]` — task/asset/approval summary (report §10).
 *
 * `status` does not plan, so its counts are of every node in `tasks.jsonl`, including orphans
 * the current plan no longer wants — a task whose prompt or references changed got a new hash
 * and left the old node behind. `vngen run` reports against the live plan instead.
 */
export async function cmdStatus(args: Args): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  const counts: Record<string, number> = {};
  for (const t of project.graph.all()) counts[t.status] = (counts[t.status] ?? 0) + 1;

  ok(`Project: ${project.config.title}`);
  ok(`Scenes: ${project.model.scenes.size} (${project.model.reachable.size} reachable)`);
  ok(`Characters: ${project.model.characters.size}  Locations: ${project.model.locations.size}`);
  const assets = project.store.manifest().length;
  const base = project.store.base;
  ok(`Assets: ${assets}`);
  if (base) {
    // Base first because it is what everything else references, and `project` is the remainder
    // by construction: `manifest()` is the union with base winning any hash both roots hold.
    ok(`  base: ${base.count}  project: ${assets - base.count}`);
    if (base.state === 'unavailable') {
      ok(`  base root UNAVAILABLE — ${base.root} has no readable manifest.json.`);
    } else if (base.state === 'absent') {
      ok(`  base root not created yet (${base.root}); the first base asset written creates it.`);
    }
  }
  // Suspension is derived, so this is a walk over the manifest rather than a stored count. The
  // desktop app's `asset.suspended` lists them; this prints a count and where to look
  const suspended = suspendedAssets({
    model: project.model,
    assets: project.store.manifest(),
    shots: await loadSceneShots(project.paths, project.model),
    angleOf: (task) => {
      const node = task ? project.graph.get(task) : undefined;
      return node && 'angle' in node.inputs ? node.inputs.angle : undefined;
    },
  });
  if (suspended.length)
    ok(`  suspended: ${suspended.length} (a reference they were drawn from moved)`);
  ok('Tasks:');
  for (const status of ['pending', 'running', 'done', 'failed', 'needs_human'] as const) {
    if (counts[status]) ok(`  ${status}: ${counts[status]}`);
  }
  const failed = project.graph.all().filter((t) => t.status === 'failed');
  for (const t of failed.slice(0, FAILURES_SHOWN)) {
    ok(`    ${t.kind} ${t.hash.slice(0, 12)} — ${t.error ?? 'no reason recorded'}`);
  }
  if (failed.length > FAILURES_SHOWN) ok(`    … and ${failed.length - FAILURES_SHOWN} more`);
  await printGraphStatus(project);
  const gate = gateStatus(project.model);
  ok(`Gate: ${gate.cleared ? 'cleared' : `awaiting approval — ${gate.pending.join(', ')}`}`);
  return 0;
}

/**
 * The refusal, if the run declined to plan. Printed instead of a preview or a task count: a
 * zero-work summary is otherwise indistinguishable from a finished project.
 */
function printRefusal(summary: RunSummary): boolean {
  if (!summary.refused) return false;
  ok('Refused to plan:');
  ok(`  ${summary.refused}`);
  return true;
}

/**
 * The project's generation graphs, wired to the services a run reaches the outside world
 * through. A graph that will not load and a slot two graphs claim are both printed rather than
 * refused: the fixed runners still draw the rest of the wave, and stopping would cost that work.
 */
async function loadGraphs(
  project: LoadedProject,
  build: () => Promise<GenDeps>,
): Promise<{ docs: GraphDoc[]; runtime?: GraphRuntime }> {
  const { docs, problems } = await readProjectGraphs(project.dir, project.paths);
  for (const problem of problems) ok(`Graph not loaded — ${problem}`);
  // `build` is deferred because a project with no graph needs no image key, and resolving one
  // would refuse a run that was never going to call the backend behind it.
  if (docs.length === 0) return { docs };

  const deps = await build();
  const { runtime, conflicts } = graphRuntime(project.paths, docs, {
    model: project.model,
    store: project.store,
    providers: deps.providers,
    imageBackend: deps.imageBackend,
    ...(deps.keys === undefined ? {} : { keys: deps.keys }),
  });
  for (const slot of conflicts) {
    ok(`More than one active output claims ${slot}, so no graph draws it.`);
  }
  return { docs, runtime };
}

/**
 * What the graphs are expected to spend, printed under the call counts it replaces. Every slot
 * a graph draws and nothing has drawn yet is priced, planned or not, because the planner runs
 * one wave per run and a slot a later wave unlocks would otherwise be quoted at nothing.
 */
async function printGraphCost(project: LoadedProject, docs: readonly GraphDoc[]): Promise<void> {
  if (docs.length === 0) return;

  const report = reportGraphs(docs, { maxRefineAttempts: project.config.max_refine_attempts });
  const slots = unrenderedBoundSlots(report, {
    model: project.model,
    config: project.config,
    assets: project.store.manifest(),
    shots: await loadSceneShots(project.paths, project.model),
    graph: project.graph,
  });
  const cost = priceSlots(report, slots);

  ok('Generation graphs:');
  ok(`  slots to draw: ${cost.slots} of ${report.bound.size} bound`);
  ok(`  estimated:     $${cost.usd.toFixed(2)}`);
  if (cost.unpriced.length) ok(`  no price for:  ${cost.unpriced.join(', ')}`);
  if (report.pricesAsOf) {
    ok(`  prices as of ${report.pricesAsOf}${report.stale ? ' — over three months old' : ''}`);
  }
}

/** Print the planned-work preview from a dry-run summary (shared by `cost` and `run --mock`). */
function printPreview(summary: RunSummary, header: string): void {
  if (printRefusal(summary)) return;
  const { preview } = summary;
  ok(header);
  ok(`  pending tasks: ${preview.pendingTasks}`);
  if (preview.boundTasks) {
    ok(`  drawn by a graph: ${preview.boundTasks} (counted by the graph estimate below)`);
  }
  ok(`  image calls:   ${preview.imageCalls}`);
  ok(`  review calls:  ${preview.reviewCalls}`);
  for (const [kind, n] of Object.entries(preview.byKind)) if (n) ok(`    ${kind}: ${n}`);
  ok(
    `Gate: ${summary.gate.cleared ? 'cleared' : `awaiting approval — ${summary.gate.pending.join(', ')}`}`,
  );
}

/**
 * `vngen decompose [dir]` — ask the writing model for a storyboard for every reachable scene that
 * has none yet, so the whole graph exists before anything is rendered.
 *
 * `--mock` is refused by name rather than honoured: mock providers give the deterministic baseline
 * for every scene, `decomposeAll` declines to write a baseline, and the run would report nothing
 * done.
 *
 * Exits 1 when any scene went unwritten, because a fallback and an unreadable file are both things
 * the author has to act on before the next run freezes the wrong storyboard in.
 */
export async function cmdDecompose(args: Args, logger: Logger): Promise<number> {
  if (args.flags['mock']) {
    ok('vngen decompose: --mock would produce the deterministic baseline for every scene, which');
    ok('  is never written — a storyboard file wins forever. Run it with real keys, or let');
    ok('  `vngen run` fall back per scene as it always has.');
    return 1;
  }
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) reportDiagnostics(project.model);
  assertValid(project.model);

  const providers = await buildProviders(project, { logger, require: ['anthropic'] });
  const result = await decomposeAll({
    model: project.model,
    providers,
    paths: project.paths,
    logger,
  });

  ok(`Decomposed ${result.decomposed.length} scene(s); ${result.kept.length} already had one.`);
  for (const f of result.fellBack) ok(`  not written — ${f.scene}: ${f.reason}`);
  for (const u of result.unreadable) ok(`  unreadable — ${u.scene}: ${u.error}`);
  return result.fellBack.length || result.unreadable.length ? 1 : 0;
}

/** `vngen cost [dir]` — dry-run cost preview without spending (report §10). */
export async function cmdCost(args: Args, logger: Logger): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) reportDiagnostics(project.model);
  assertValid(project.model);
  const deps = await buildGenDeps(project, { mock: true, logger });
  const graphs = await loadGraphs(project, () => Promise.resolve(deps));
  const summary = await runPipeline({
    ...project,
    providers: deps.providers,
    dryRun: true,
    logger,
    ...(graphs.runtime === undefined ? {} : { graphs: graphs.runtime }),
  });
  printPreview(summary, 'Cost preview (upper bound):');
  await printGraphCost(project, graphs.docs);
  return summary.refused ? 1 : 0;
}

/**
 * `vngen run [dir] [--mock]` — execute to the next gate (report §10). `--mock` is a dry run:
 * it plans, writes the story graph, and previews the work without calling any model or
 * writing assets (no API keys needed). Drop `--mock` to generate for real.
 *
 * Exits 1 when the current plan still wants a `failed` task: the art the command promised
 * does not exist, whether this run is what lost it or an earlier one was.
 *
 * `providers` is a test seam, the counterpart of {@link ApproveIO}: a real run resolves keys
 * and builds backends, which a test of the reporting has no way to stand in for.
 */
export async function cmdRun(
  args: Args,
  logger: Logger,
  providersOverride?: Providers,
): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const mock = Boolean(args.flags['mock']);
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) {
    ok('Validation:');
    reportDiagnostics(project.model);
  }
  assertValid(project.model);

  await writeStoryGraph(project.paths, toMermaid(project.model));
  const providers = providersOverride ?? (await buildProviders(project, { mock, logger }));
  // The graphs are indexed against the providers the run actually uses, so an overridden bundle
  // draws the graph's pictures too rather than only the tasks the fixed runners take.
  const graphs = await loadGraphs(project, async () => ({
    ...(await buildGenDeps(project, { mock, logger })),
    providers,
  }));

  const summary = await runPipeline({
    ...project,
    providers,
    dryRun: mock,
    logger,
    now: () => new Date().toISOString(),
    ...(graphs.runtime === undefined ? {} : { graphs: graphs.runtime }),
  });

  if (mock) {
    printPreview(summary, 'Dry run (--mock) — planned work, nothing generated:');
    await printGraphCost(project, graphs.docs);
    return summary.refused ? 1 : 0;
  }
  if (printRefusal(summary)) return 1;

  // Counted from the plan rather than from `summary.ran`: a failure inherited from an earlier run
  // transitions nothing this process can see
  const { failed, needsHuman } = summary;
  ok(`Ran ${summary.ran.length} task(s).`);
  if (summary.retried.length) ok(`  retried from an earlier run: ${summary.retried.length}`);
  if (failed.length) ok(`  failed: ${failed.length}`);
  if (needsHuman.length) ok(`  needs human: ${needsHuman.length}`);
  ok(`Assets in manifest: ${project.store.manifest().length}`);

  if (failed.length) {
    ok('');
    ok('Failed tasks:');
    for (const t of failed.slice(0, FAILURES_SHOWN)) {
      ok(`  ${t.kind} ${t.hash.slice(0, 12)} — ${t.error ?? 'no reason recorded'}`);
    }
    if (failed.length > FAILURES_SHOWN) ok(`  … and ${failed.length - FAILURES_SHOWN} more`);
    const budget = project.config.max_task_attempts;
    const retriable = failed.filter((t) => spentAttempts(t) < budget).length;
    ok(
      retriable
        ? `${retriable} of them will be retried by the next \`vngen run\`.`
        : `The attempt budget (max_task_attempts: ${budget}) is spent — none will be retried.`,
    );
  }

  if (summary.blockedOnGate) {
    ok('');
    ok('Halted at the character-approval gate. Pending characters:');
    for (const id of summary.gate.pending) {
      ok(`  ${id} — review candidates in ${project.paths.candidatesDir(id)}`);
    }
    ok(`Approve them interactively with: vngen approve${dir === '.' ? '' : ` ${dir}`}`);
  } else if (failed.length) {
    ok(`Gate cleared, but ${failed.length} task(s) failed — art is missing.`);
  } else {
    ok('Gate cleared — all reachable shots generated.');
  }
  // A failure means the artifact the command promised does not exist. `needs_human` means it
  // exists and wants review, which is not the command's failure.
  return failed.length > 0 ? 1 : 0;
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

/** A blank answer takes the default; anything else is true only for `y` or `yes`. */
function answeredYes(answer: string, dflt: boolean): boolean {
  const t = answer.trim().toLowerCase();
  if (!t) return dflt;
  return t === 'y' || t === 'yes';
}

/** The character's portrait candidates in the manifest (one per character today). */
function portraitsFor(project: LoadedProject, characterId: string): Asset[] {
  return project.store
    .manifest()
    .filter((a) => a.kind === 'portrait' && bindsTo(a, { characterId }));
}

/** Flip the character to approved with `hash`, copy the visible portrait, accept the asset. */
async function approveCharacter(
  project: LoadedProject,
  characterId: string,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const file = entityFile(project.inputs.characterDocs, characterId);
  if (!file || !(await setCharacterApproval(file, hash))) {
    return { ok: false, message: `No character file for "${characterId}".` };
  }
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
