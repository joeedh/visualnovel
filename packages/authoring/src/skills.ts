/**
 * Skill discovery, writing, and (permissioned) execution (authoring-agent plan §6.5). A skill
 * is a directory under `.aiagent/skills/<id>/` containing `SKILL.md` (front-matter `name`,
 * `description`, `when-to-use`) and an optional script. Skills are reusable authoring
 * playbooks: a pure-prose skill returns its body as guidance for the agent; a script-bearing
 * skill runs a vetted command — and the **first/each run is permissioned** (the plan's
 * always-confirm rule), because a script can do arbitrary work.
 *
 * The writer lives here, beside the reader, so the two cannot drift: `readSkill` parses with
 * `@vn/parse`'s `parseFrontMatter` and `skillDoc` emits through its exact inverse,
 * `stringifyFrontMatter`. That is also what lets the desktop scaffold and the agent's
 * `create_skill` produce byte-identical files from the same name.
 *
 * Discovery and parsing reuse `@vn/parse`'s front-matter reader; nothing here re-implements
 * parsing. Execution shells out via `node:child_process` (non-interactive), like `@vn/git`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, posix } from 'node:path';
import { promises as fs } from 'node:fs';
import { parseFrontMatter, stringifyFrontMatter, type FrontMatterDoc } from '@vn/parse';
import { exists, readText, writeFileAtomic } from '@vn/util';

const run = promisify(execFile);

/** The default per-project skills directory (relative to the workspace root). */
export const PROJECT_SKILLS_DIR = join('.aiagent', 'skills');

/** The one file that makes a directory a skill. */
export const SKILL_FILE = 'SKILL.md';

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
  /**
   * The front-matter exactly as parsed. `edit_skill` rewrites a `SKILL.md` from its four modeled
   * keys, so this is what lets it carry forward keys it does not model — most importantly a
   * human's `script:`.
   */
  raw: Record<string, unknown>;
  /** What {@link readSkill} degraded over, in the order a reader should fix them (often empty). */
  issues: string[];
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
export async function readSkill(dir: string, id: string): Promise<Skill | null> {
  const file = join(dir, SKILL_FILE);
  if (!(await exists(file))) return null;
  const doc = parseFrontMatter(await readText(file));
  const data = doc.data;
  const name = typeof data['name'] === 'string' ? (data['name'] as string) : id;
  const description =
    typeof data['description'] === 'string' ? (data['description'] as string) : '';
  const whenRaw = data['when-to-use'] ?? data['whenToUse'];
  const whenToUse = typeof whenRaw === 'string' ? whenRaw : undefined;
  const script = await findScript(dir, data['script']);
  const skill: Skill = {
    id,
    name,
    description,
    whenToUse,
    dir,
    file,
    body: doc.body.trim(),
    script,
    raw: data,
    issues: [],
  };
  skill.issues = skillIssues(skill);
  return skill;
}

/**
 * What a skill silently degraded over, in the order a reader should fix them. Every one of these
 * is a case {@link readSkill} papers over — a missing `name` becomes the directory id, a missing
 * `description` becomes `''` — so without this list the agent's own catalogue would show a skill
 * that looks fine and reads as nothing.
 */
export function skillIssues(skill: Skill): string[] {
  const issues: string[] = [];
  if (typeof skill.raw['name'] !== 'string' || !skill.raw['name'].trim()) {
    issues.push(`no name in front-matter (falling back to the directory name "${skill.id}")`);
  }
  if (!skill.description.trim()) {
    issues.push('no description — the agent has nothing to decide by');
  }
  if (!skill.body.trim()) {
    issues.push('no instructions in the body');
  }
  const named = skill.raw['script'];
  if (typeof named === 'string' && named.trim() && skill.script !== join(skill.dir, named.trim())) {
    // `findScript` falls through to the `run.mjs|run.js|run.cjs|run.sh` scan when `script:` names
    // a file that is not there, so a stale script runs under a name nobody wrote down.
    const ran = skill.script ? basename(skill.script) : '';
    issues.push(
      ran
        ? `script: names "${named.trim()}", which is missing — "${ran}" beside it runs instead`
        : `script: names "${named.trim()}", which is missing`,
    );
  }
  return issues;
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

// ── Writing ───────────────────────────────────────────────────────────────────

/** The modeled front-matter keys, in the order `skillDoc` emits them. */
const MODELED_KEYS = ['name', 'description', 'when-to-use', 'whenToUse'];

/**
 * A hyphenated skill id from a name; `''` when nothing survives.
 *
 * Deliberately **ASCII-only**, unlike `@vn/model`'s `slug` — which keeps `\p{Letter}\p{Number}`
 * and would happily mint a wholly non-Latin directory name, and which hyphenates with
 * underscores besides. A skill id becomes a directory that a `run.mjs` is resolved against and
 * handed to `execFile`, so it stays in the portable set; a name that slugs to `''` is refused
 * with a message asking for a Latin id rather than calling the name invalid.
 */
export function skillId(name: string): string {
  return (
    name
      .normalize('NFKD')
      // NFKD splits an accented letter into base + combining mark; drop the marks so `Café` is
      // `cafe` rather than `cafe-`, which is what a leftover non-alphanumeric would make it.
      .replace(/\p{M}/gu, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 64)
      .replace(/-+$/, '')
  );
}

/**
 * Whether `id` is a well-formed skill id. This gates **creation only**: `edit_skill` resolves
 * through `discoverSkills`, which reads whatever the directory is actually called, so a
 * hand-made id this would refuse to mint stays editable. Keep that asymmetry.
 */
export function isSkillId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

/** The fields a skill is written from. */
export interface SkillInput {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}

/**
 * The canonical `SKILL.md`: the four modeled keys in a fixed order, then whatever `preserve`
 * carries that this file does not model (a human's `script:`, most of all).
 *
 * This re-serializes where `renameInText` splices, and the difference is the document: a wiki
 * page's front-matter is open-ended and hand-ordered, so re-emitting it would reflow keys the
 * author chose; a `SKILL.md` has four known keys whose order this function owns, so canonical
 * output is the point. What re-emitting still loses is **comments**, including one above a
 * human's `script:`. That cost is accepted and stated in `edit_skill`'s description.
 */
export function skillDoc(
  input: SkillInput,
  preserve: Record<string, unknown> = {},
): FrontMatterDoc {
  const data: Record<string, unknown> = { name: input.name, description: input.description };
  const when = input.whenToUse?.trim();
  if (when) data['when-to-use'] = when;
  for (const [key, value] of Object.entries(preserve)) {
    if (MODELED_KEYS.includes(key)) continue;
    data[key] = value;
  }
  return { data, body: `${input.body.trim()}\n` };
}

/**
 * The `SKILL.md` an author gets when they ask for a skill and say nothing else. Shared by
 * `doc.create kind='skill'` and the agent's `create_skill`, for the same reason
 * `newCharacterTemplate` is shared: the human's scaffold and the agent's write are then the
 * same bytes, and a reader cannot tell which made a file by looking at it.
 */
export function newSkillTemplate(name: string): string {
  return stringifyFrontMatter(
    {
      name,
      description: 'One sentence saying what this playbook is for.',
      'when-to-use': 'The situation that should make the agent reach for this skill.',
    },
    `# ${name}

Write the procedure here, as steps the agent can follow.

1. What to read first, and what it is looking for.
2. What to write, and which tool writes it.
3. How to check the result, and what to propose as a commit message.

Keep it about *this* project: general advice the agent already has is noise.
`,
  );
}

/** What `writeSkill` answers with. */
export type SkillWriteResult =
  | { ok: true; id: string; file: string }
  | { ok: false; reason: string };

/**
 * Write `<root>/.aiagent/skills/<id>/SKILL.md`. Refuses an existing **directory** unless
 * `overwrite` — a directory is the unit a skill occupies, and one already holding a vetted
 * `run.mjs` is not somewhere a new skill gets scaffolded on top of.
 */
export async function writeSkill(
  root: string,
  input: SkillInput,
  opts: { overwrite?: boolean; preserve?: Record<string, unknown> } = {},
): Promise<SkillWriteResult> {
  // Whatever else it is, an id names one directory and never a path.
  if (!input.id || input.id === '.' || input.id === '..' || basename(input.id) !== input.id) {
    return {
      ok: false,
      reason: `"${input.id}" is not a skill id: it names a directory, not a path.`,
    };
  }
  // `isSkillId` gates creation only. Overwriting means the directory was found by discovery,
  // which reads whatever it is actually called, so its name is not this function's to judge.
  if (!opts.overwrite && !isSkillId(input.id)) {
    return {
      ok: false,
      reason: `"${input.id}" is not a skill id: give the skill a name with Latin letters or digits in it.`,
    };
  }
  const dir = join(root, PROJECT_SKILLS_DIR, input.id);
  if (!opts.overwrite && (await exists(dir))) {
    return { ok: false, reason: `skill ${input.id} already exists` };
  }
  const file = join(dir, SKILL_FILE);
  const doc = skillDoc(input, opts.preserve);
  // `writeFileAtomic` makes the directory, so scaffolding a skill needs no mkdir of its own.
  await writeFileAtomic(file, stringifyFrontMatter(doc.data, doc.body));
  return { ok: true, id: input.id, file };
}

/** The one sentence `write_file` refuses `.aiagent/skills/**` with. */
const SKILL_WRITE_REFUSAL =
  '.aiagent/skills/ is written by `create_skill` and `edit_skill`, which write prose only — ' +
  'a skill that runs a script has to be added by a person.';

/**
 * Non-null when `write_file` must refuse this workspace-relative path.
 *
 * Normalizes and **lowercases**: `rel` forward-slashes but does not case-fold, and
 * `.AIAGENT/skills/x` is the same directory as `.aiagent/skills/x` on Windows and on default
 * macOS. `..` is resolved first, so `characters/../.aiagent/skills/x/run.mjs` is caught too.
 */
export function skillWriteRefusal(relPath: string): string | null {
  const norm = posix.normalize(relPath.replace(/\\/g, '/')).toLowerCase();
  const dir = PROJECT_SKILLS_DIR.replace(/\\/g, '/').toLowerCase();
  if (norm === dir || norm.startsWith(`${dir}/`)) return SKILL_WRITE_REFUSAL;
  return null;
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
