import type { Logger } from '@vn/types';
import { toMermaid } from '@vn/model';
import { writeApprovedPortrait, writeStoryGraph, setCharacterApproval } from '@vn/store';
import { gateStatus } from '@vn/pipeline';
import { runPipeline } from '@vn/scheduler';
import { assertValid, buildProviders, loadProject } from './project.js';

/** Parsed CLI invocation: positional args + `--flag[=value]` options. */
export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=', 2);
      flags[key!] = value ?? true;
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

/** `vngen cost [dir]` — dry-run cost preview without spending (report §10). */
export async function cmdCost(args: Args, logger: Logger): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) reportDiagnostics(project.model);
  assertValid(project.model);
  const providers = await buildProviders(project, { mock: true, logger });
  const summary = await runPipeline({ ...project, providers, dryRun: true, logger });
  const { preview } = summary;
  ok('Cost preview (upper bound):');
  ok(`  pending tasks: ${preview.pendingTasks}`);
  ok(`  image calls:   ${preview.imageCalls}`);
  ok(`  review calls:  ${preview.reviewCalls}`);
  for (const [kind, n] of Object.entries(preview.byKind)) if (n) ok(`    ${kind}: ${n}`);
  ok(`Gate: ${summary.gate.cleared ? 'cleared' : `awaiting ${summary.gate.pending.join(', ')}`}`);
  return 0;
}

/** `vngen run [dir] [--mock]` — execute to the next gate (report §10). */
export async function cmdRun(args: Args, logger: Logger): Promise<number> {
  const dir = args.positional[0] ?? '.';
  const project = await loadProject(dir);
  if (project.model.diagnostics.length) {
    ok('Validation:');
    reportDiagnostics(project.model);
  }
  assertValid(project.model);

  await writeStoryGraph(project.paths, toMermaid(project.model));
  const providers = await buildProviders(project, {
    mock: Boolean(args.flags['mock']),
    logger,
  });

  const summary = await runPipeline({
    ...project,
    providers,
    logger,
    now: () => new Date().toISOString(),
  });

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
    ok('Approve with: vngen approve <character> <assetHash> [dir]');
  } else {
    ok('Gate cleared — all reachable shots generated.');
  }
  return 0;
}

/** `vngen approve <character> <hash> [dir]` — pass a portrait through the gate (report §P3). */
export async function cmdApprove(args: Args): Promise<number> {
  const [characterId, hash, dir = '.'] = args.positional;
  if (!characterId || !hash) {
    ok('Usage: vngen approve <character> <assetHash> [dir]');
    return 1;
  }
  const project = await loadProject(dir);
  if (!project.store.has(hash)) {
    ok(`No asset with hash "${hash}" in the store.`);
    return 1;
  }
  const flipped = await setCharacterApproval(project.paths, characterId, hash);
  if (!flipped) {
    ok(`No character file for "${characterId}".`);
    return 1;
  }
  const bytes = await project.store.read({ hash, ext: 'png' });
  await writeApprovedPortrait(project.paths, characterId, bytes);
  await project.store.accept(hash);
  ok(`Approved ${characterId} → ${hash}. Re-run \`vngen run ${dir}\` to continue past the gate.`);
  return 0;
}
