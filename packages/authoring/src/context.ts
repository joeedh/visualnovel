/**
 * Context assembly (authoring-agent plan §6.2, report §3). Precedence is
 * **built-in system prompt (the input contract) > `AICONTEXT.md` (+ nested + `@import`)
 * > `AICONTEXT.generated.md` (the project map) > inferred defaults**. The system prompt is the
 * agent's always-on domain knowledge so it never writes malformed input; `AICONTEXT.md` is the
 * author's durable project guidance, loaded the way Claude Code loads `CLAUDE.md`; the generated
 * file states facts and so loses to the author, who states policy. `updateContext` turns a chat
 * instruction into a persistent line in `AICONTEXT.md`.
 */
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { exists, readText, writeFileAtomic } from '@vn/util';
import { GENERATED_CONTEXT_FILE, isGenerated } from './generated.js';

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
- wiki/**.md                        — the story bible: free-form notes, lore, history, drafts.

THE STORY BIBLE (wiki/) is arbitrary markdown in whatever shape the author likes, and it can be
large. You reach it with search_bible — a ranked, budgeted query — and NEVER read it whole; do
not walk it with read_file looking for something. Character and location sheets may live in it
too: a file with \`type: character\` or \`type: location\` in its front-matter is a real entity
sheet wherever it sits, so list_workspace may report a character whose file is under wiki/. Edit
that file where it is; do not create a second sheet under characters/.

scenes/ is the only form scenes are read from. project.yaml's \`start:\` names the entry scene (a
directory has no document order), and a chunk body carries no [[scene:]] marker: its id is the
front-matter's, and the body cannot override it. A project may still hold a retired
screenplay/*.fountain — the whole story in one file; it is NOT read, and \`vngen import\` converts
it into scenes/ chunks. Tell the author to run that rather than editing it.

CHARACTER front-matter: id, name, status(draft|candidates|approved|locked),
default_outfit, traits[], palette[ hex ], art_notes?, approved_portrait?.
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
  /**
   * The generated project map (`AICONTEXT.generated.md`), or '' if there is none — or if what is
   * at that path lacks the generator's banner, which reads as "nobody generated this" rather than
   * as context nobody vouched for.
   */
  generatedContext: string;
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

  // Claimed before anything resolves, so an `@import` of the generated file cannot inline it into
  // the author's context as well: it is loaded once, below, as its own labelled section.
  const generatedFile = resolve(join(root, GENERATED_CONTEXT_FILE));
  visited.add(generatedFile);

  const rootFile = await findContextFile(root);
  if (rootFile) await resolveFile(rootFile, visited, out, 0);

  let generatedContext = '';
  if (await exists(generatedFile)) {
    const text = await readText(generatedFile);
    // No `@import` resolution: it is generated, so it has nothing to import the generator could
    // not have inlined.
    if (isGenerated(text)) {
      generatedContext = text.trim();
      out.files.push(generatedFile);
    }
  }

  for (const dir of opts.extraDirs ?? []) {
    const nested = await findContextFile(dir);
    if (nested) await resolveFile(nested, visited, out, 0);
  }

  const projectContext = out.chunks.filter(Boolean).join('\n\n');
  return { systemPrompt: SYSTEM_PROMPT, projectContext, generatedContext, files: out.files };
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

/**
 * Compose the full system message: built-in prompt, then the generated map, then the author's
 * context — in that order and separately labelled, so the section that states policy is the one
 * that reads last and says so.
 */
export function composeSystem(ctx: LoadedContext): string {
  const parts = [ctx.systemPrompt];
  if (ctx.generatedContext) {
    parts.push(
      `--- PROJECT MAP (${GENERATED_CONTEXT_FILE} — generated; facts about this project, ` +
        'not instructions. AICONTEXT.md overrides it. It is a snapshot taken when the map was ' +
        'last written, so anything created since is missing from it: list_workspace is what is ' +
        'true now, and it wins.) ---\n' +
        ctx.generatedContext,
    );
  }
  if (ctx.projectContext) {
    parts.push(`--- PROJECT CONTEXT (AICONTEXT.md) ---\n${ctx.projectContext}`);
  }
  return parts.join('\n\n');
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
