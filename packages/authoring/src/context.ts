/**
 * Context assembly (authoring-agent plan §6.2, report §3). Precedence is
 * **built-in system prompt (the input contract) > `AICONTEXT.md` (+ nested + `@import`)
 * > inferred defaults**. The system prompt is the agent's always-on domain knowledge so
 * it never writes malformed input; `AICONTEXT.md` is the author's durable project
 * guidance, loaded the way Claude Code loads `CLAUDE.md`. `updateContext` turns a chat
 * instruction into a persistent line in `AICONTEXT.md`.
 */
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { exists, readText, writeFileAtomic } from '@vn/util';

/** Filenames searched for project guidance, in precedence order. */
export const CONTEXT_FILENAMES = ['AICONTEXT.md', 'AGENTS.md', 'CLAUDE.md'];

/** The built-in input-contract system prompt (report §2). */
export const SYSTEM_PROMPT = `You are the VN authoring agent. You help an author create and refine the INPUT files
of a visual-novel generator: characters, locations, and a branching Fountain screenplay.
You work ONLY on these source files; you never run the image-generation pipeline.

PROJECT LAYOUT (the input contract):
- project.yaml                      — title, art_style, model ids, key env-var names.
- characters/<id>/character.md      — YAML front-matter + canonical prose description.
- locations/<id>.md                 — YAML front-matter + prose description.
- scenes/<id>.md                    — one scene per file: \`scene: <id>\` front-matter + a
                                      complete one-scene Fountain body (heading included).

scenes/ is the only form scenes are read from. project.yaml's \`start:\` names the entry scene (a
directory has no document order), and a chunk body carries no [[scene:]] marker: its id is the
front-matter's, and the body cannot override it. A project may still hold a retired
screenplay/*.fountain — the whole story in one file; it is NOT read, and \`vngen import\` converts
it into scenes/ chunks. Tell the author to run that rather than editing it.

CHARACTER front-matter: id, name, status(draft|candidates|approved|locked),
default_outfit, traits[], palette[ hex ], reference_images[], approved_portrait?.
The markdown body is the canonical description fed to the model.

LOCATION front-matter: id, name, mood?, lighting?, palette[ hex ], variants[ id ].
The body is the description.

FOUNTAIN + BRANCH MARKERS: standard Fountain, plus markers inside notes ([[ ... ]]):
  [[scene: s12_rooftop]]              assigns a stable id to the current scene
  [[choice: "Tell the truth" -> s13]] a labelled branch edge
  [[next: s13]]                       a linear continuation
Scene headings (INT./EXT.) mine locations and time-of-day variants.

CROSS-FILE INVARIANTS you must preserve:
- every character cue in the screenplay resolves to a defined character,
- every choice/next target resolves to a real scene,
- every scene location resolves to a defined or mined location,
- the entry scene reaches every intended scene (no accidental dead branches).

HOW YOU WORK:
- Plan before acting. In plan mode you only read, search, and propose; you make NO edits.
- The user approves a plan, then you execute: apply edits, validate, and commit to git.
- Block a commit on error-severity validation; warn (do not block) on soft/style issues.
- Reverts, restores, file deletion, and first-run of a script-bearing skill need explicit
  user confirmation naming the target.
- Never read, log, or commit API keys. Stay within the project directory.
- Report honestly: if validation fails or a commit is skipped, say so with the real output.`;

/** Result of assembling project context. */
export interface LoadedContext {
  /** The built-in input-contract prompt. */
  systemPrompt: string;
  /** The user's project guidance (AICONTEXT.md + nested + imports), or '' if none. */
  projectContext: string;
  /** Absolute paths of every context file that contributed, in load order. */
  files: string[];
}

const IMPORT_RE = /^@(?:import\s+)?(\S+)\s*$/;

/** Resolve a single context file, inlining `@import <path>` lines (cycle-guarded). */
async function resolveFile(
  file: string,
  visited: Set<string>,
  out: { files: string[]; chunks: string[] },
  depth: number,
): Promise<void> {
  const abs = resolve(file);
  if (visited.has(abs) || depth > 8) return;
  if (!(await exists(abs))) return;
  visited.add(abs);
  out.files.push(abs);

  const text = await readText(abs);
  const lines = text.split('\n');
  const body: string[] = [];
  for (const line of lines) {
    const m = IMPORT_RE.exec(line.trim());
    if (m) {
      const target = m[1]!;
      const resolved = isAbsolute(target) ? target : join(dirname(abs), target);
      await resolveFile(resolved, visited, out, depth + 1);
    } else {
      body.push(line);
    }
  }
  out.chunks.push(body.join('\n').trim());
}

/** Pick the first existing context filename in a directory, by precedence. */
async function findContextFile(dir: string): Promise<string | undefined> {
  for (const name of CONTEXT_FILENAMES) {
    const p = join(dir, name);
    if (await exists(p)) return p;
  }
  return undefined;
}

/**
 * Assemble the agent context for a workspace. Loads the root context file (AICONTEXT.md,
 * falling back to AGENTS.md/CLAUDE.md), resolves its `@import`s, and pulls in any nested
 * context files from `extraDirs` (e.g. the directory of a character being edited).
 */
export async function loadContext(
  root: string,
  opts: { extraDirs?: string[] } = {},
): Promise<LoadedContext> {
  const visited = new Set<string>();
  const out = { files: [] as string[], chunks: [] as string[] };

  const rootFile = await findContextFile(root);
  if (rootFile) await resolveFile(rootFile, visited, out, 0);

  for (const dir of opts.extraDirs ?? []) {
    const nested = await findContextFile(dir);
    if (nested) await resolveFile(nested, visited, out, 0);
  }

  const projectContext = out.chunks.filter(Boolean).join('\n\n');
  return { systemPrompt: SYSTEM_PROMPT, projectContext, files: out.files };
}

/**
 * Persist a durable instruction to the workspace `AICONTEXT.md`, creating it if absent.
 * Returns the file path (so the caller can stage/commit it). The rule is appended under a
 * stable heading so repeated calls accumulate rather than overwrite.
 */
export async function updateContext(root: string, rule: string): Promise<string> {
  const file = join(root, 'AICONTEXT.md');
  const line = `- ${rule.trim()}`;
  let next: string;
  if (await exists(file)) {
    const current = (await readText(file)).replace(/\s+$/, '');
    next = `${current}\n${line}\n`;
  } else {
    next = `# Project context\n\nDurable guidance for the authoring agent.\n\n${line}\n`;
  }
  await writeFileAtomic(file, next);
  return file;
}

/** Compose the full system message: built-in prompt + project context. */
export function composeSystem(ctx: LoadedContext): string {
  if (!ctx.projectContext) return ctx.systemPrompt;
  return `${ctx.systemPrompt}\n\n--- PROJECT CONTEXT (AICONTEXT.md) ---\n${ctx.projectContext}`;
}

/** True when `child` is inside `root` (used to keep the agent scoped to the workspace). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Discover the nested directories worth pulling context from, given referenced ids. */
export async function nestedContextDirs(root: string, characterIds: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const id of characterIds) {
    const dir = join(root, 'characters', id);
    if (await exists(dir)) dirs.push(dir);
  }
  return dirs;
}
