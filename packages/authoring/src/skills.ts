/**
 * Skill discovery + (permissioned) execution (authoring-agent plan §6.5). A skill is a
 * directory under `.aiagent/skills/<id>/` containing `SKILL.md` (front-matter `name`,
 * `description`, `when-to-use`) and an optional script. Skills are reusable authoring
 * playbooks: a pure-prose skill returns its body as guidance for the agent; a script-bearing
 * skill runs a vetted command — and the **first/each run is permissioned** (the plan's
 * always-confirm rule), because a script can do arbitrary work.
 *
 * Discovery and parsing reuse `@vn/parse`'s front-matter reader; nothing here re-implements
 * parsing. Execution shells out via `node:child_process` (non-interactive), like `@vn/git`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { parseFrontMatter } from '@vn/parse';
import { exists, readText } from '@vn/util';

const run = promisify(execFile);

/** The default per-project skills directory (relative to the workspace root). */
export const PROJECT_SKILLS_DIR = join('.aiagent', 'skills');

/** Candidate script filenames inside a skill directory, in precedence order. */
const SCRIPT_FILES = ['run.mjs', 'run.js', 'run.cjs', 'run.sh'];

/** A discovered skill. */
export interface Skill {
  /** Stable id (the skill directory name). */
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** The skill directory. */
  dir: string;
  /** The `SKILL.md` path. */
  file: string;
  /** The instruction body (prose) the agent should follow. */
  body: string;
  /** Absolute path to the skill's script, if it has one. */
  script?: string;
}

/** Resolve the skill roots to scan for a workspace. */
export function skillRoots(workspaceRoot: string, extraDirs: string[] = []): string[] {
  return [join(workspaceRoot, PROJECT_SKILLS_DIR), ...extraDirs];
}

async function findScript(dir: string, fromFrontMatter: unknown): Promise<string | undefined> {
  if (typeof fromFrontMatter === 'string' && fromFrontMatter.trim()) {
    const p = join(dir, fromFrontMatter.trim());
    if (await exists(p)) return p;
  }
  for (const name of SCRIPT_FILES) {
    const p = join(dir, name);
    if (await exists(p)) return p;
  }
  return undefined;
}

/** Read a single skill directory into a {@link Skill}, or null if it has no `SKILL.md`. */
async function readSkill(dir: string, id: string): Promise<Skill | null> {
  const file = join(dir, 'SKILL.md');
  if (!(await exists(file))) return null;
  const doc = parseFrontMatter(await readText(file));
  const data = doc.data;
  const name = typeof data['name'] === 'string' ? (data['name'] as string) : id;
  const description =
    typeof data['description'] === 'string' ? (data['description'] as string) : '';
  const whenRaw = data['when-to-use'] ?? data['whenToUse'];
  const whenToUse = typeof whenRaw === 'string' ? whenRaw : undefined;
  const script = await findScript(dir, data['script']);
  return { id, name, description, whenToUse, dir, file, body: doc.body.trim(), script };
}

/** Discover every skill across the given roots (later roots do not override earlier ids). */
export async function discoverSkills(roots: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!(await exists(root))) continue;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const skill = await readSkill(join(root, entry.name), entry.name);
      if (skill) {
        seen.add(entry.name);
        skills.push(skill);
      }
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** The outcome of running a skill. */
export interface SkillRunResult {
  ok: boolean;
  output: string;
  /** True when the skill ran a script (vs. returning prose guidance). */
  ranScript: boolean;
}

/** Pick the interpreter for a script by extension. */
function interpreterFor(script: string): { cmd: string; args: string[] } {
  if (script.endsWith('.sh')) return { cmd: 'sh', args: [script] };
  return { cmd: process.execPath, args: [script] };
}

/**
 * Run a skill. Pure-prose skills return their body as guidance (no side effects). A
 * script-bearing skill is gated: it executes only after `confirm` approves, naming the
 * script; without a `confirm` channel it refuses. The script runs in the workspace root
 * with the workspace path as its first argument.
 */
export async function runSkill(
  skill: Skill,
  opts: { workspaceRoot: string; confirm?: (message: string) => Promise<boolean> },
): Promise<SkillRunResult> {
  if (!skill.script) {
    const guidance = skill.body || `(skill "${skill.id}" has no instructions)`;
    return { ok: true, ranScript: false, output: `Skill "${skill.name}" guidance:\n${guidance}` };
  }

  if (!opts.confirm) {
    return {
      ok: false,
      ranScript: false,
      output: `Skill "${skill.id}" runs a script (${skill.script}) and needs confirmation, but no confirmation channel is available.`,
    };
  }
  const approved = await opts.confirm(
    `Skill "${skill.id}" wants to run a script: ${skill.script}. Allow it?`,
  );
  if (!approved) {
    return { ok: false, ranScript: false, output: `Declined: did not run skill "${skill.id}".` };
  }

  const { cmd, args } = interpreterFor(skill.script);
  try {
    const { stdout, stderr } = await run(cmd, [...args, opts.workspaceRoot], {
      cwd: opts.workspaceRoot,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = [stdout, stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n');
    return { ok: true, ranScript: true, output: output || `Skill "${skill.id}" ran (no output).` };
  } catch (err) {
    return {
      ok: false,
      ranScript: true,
      output: `Skill "${skill.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
