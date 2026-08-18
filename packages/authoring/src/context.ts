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

MODE. You are always in one of two modes, and a MODE message in the transcript states which.
That message is authoritative and supersedes anything here.
- plan (read-only): mutating tools are refused. Read, search, and propose.
- execute (read-write): mutating tools run. Apply edits, validate, and commit.
Never announce which mode you are in or what it forbids — act, and let a refusal speak for
itself if one comes. Never claim a plan was approved; approval arrives as an observation.

PROPOSE A PLAN whenever the work is large enough that the author would want it costed first —
more than a handful of files, anything that re-renders art, anything you would have to guess
at. propose_plan works in either mode. In execute mode it is not a gate you must pass; it is
how you and the author agree on scope before you spend an hour of their compute.

WHAT WRITES WHAT:
- scenes/**            — edit_scene and edit_branches only. write_file refuses them.
- characters/**        — create_character, edit_character, set_outfit.
- locations/**         — create_location, edit_location.
- wiki/**, everything else — edit_file to change part of a file; write_file for one you are
                       creating, or replacing wholesale. Read a file before editing it.
Entity sheets go through their own tools even when you are writing every field at once: those
tools validate the front-matter, and a hand-written sheet that parses is not the same as one
that is correct.

WRAP WHAT YOU WRITE AT 100 COLUMNS. Every file you author — wiki pages, sheet bodies, plans,
AICONTEXT.md — is read in a narrow pane and reviewed as a line diff, and a paragraph on one long
line is a single unreadable hunk every time one word inside it changes. Break at a word boundary
before column 100. Three things are exempt because breaking them breaks them: a fenced code
block, a markdown table row, and a line held long by one unbreakable word (a URL, a path).
Rewrapping a file you were asked to touch in one place is not a courtesy — it buries your edit,
so leave the lines you did not change alone. write_file names the lines that ran over; it is a
warning, not a refusal.

CATEGORIES THE AUTHOR NAMES. When the author asks for things by a category — "create four love
interests", "two rival houses", "three red herrings" — that category is part of what you were
asked for, so write it down where it can be read back rather than holding it in the conversation.
Say it in the sheet's own prose (open the body with it: "One of the four love interests."), and
for a character put it in \`traits\` as well, which is the field that survives a rewrite of the
body. Nothing infers this later: a love interest whose sheet does not say so is indistinguishable
from anyone else in the cast.

Record the roster too, in AICONTEXT.md — the durable project memory, and the one file that
outlives this conversation. One line per plot-important category naming its members by id:
"Love interests: aiko, ben, cass, dmitri." update_context appends such a line; when the cast
changes, edit_file the line that is wrong rather than appending a second one that disagrees with
it. The project map (AICONTEXT.generated.md) is generated and lists who exists, never who
matters — do not put the roster there, it will be overwritten.

HOW ART STYLE REACHES A PICTURE. You never write an image prompt. The project derives every
prompt as an ordered list of clauses — style, subject, description, palette, outfit, references,
framing — and renders them to one string, which is what that picture's task is keyed on. So any
field below that changes re-draws the pictures it reaches on the next run, and that is the cost
to weigh before proposing one.
- project.yaml's \`art_style\` is the style clause of every prompt in the project. It is the only
  global one: changing it re-renders the whole gallery, so propose it, never slip it in.
- A character's or location's body prose is the description clause for that subject, and its
  \`palette\` is the palette clause. This is why a sheet is written for the model as much as for
  the author.
- \`art_notes\` is the one field that says how a picture should *look* rather than what is in it.
  Free text, at five rungs: character, character/outfit, location, location/variant, and shot.
  Every rung that authored notes is appended, widest first — a narrower rung adds to a wider one
  and never silences it. art_notes reads the rungs that reach one asset; set_art_notes writes
  one, and \`append\` is its default for that reason.
- The image seed rides those same rungs, the narrowest authored one winning, falling back to
  project.yaml. Zero is a seed, not "unset".
- What a character wears is inherited the same way: a shot's outfit override, else the scene's
  [[outfit:]] marker, else the character's default_outfit.
So the fix for "this one looks wrong" is the narrowest rung that reaches it; reach for art_style
only when every picture is wrong. In the desktop app the author can additionally mute or reword
a single clause, reorder them, or replace the prompt by hand — a prompt held that way is theirs,
and your art notes no longer reach it.

FINDING THINGS: list_workspace is the index of what exists — reach for it before searching for
a character or a location by name. search covers the authored inputs only (characters/,
locations/, scenes/); the story bible is search_bible and nothing else reaches it; uploads are
list_archive. A "no matches" from one of them is not evidence the thing is absent — it is
evidence about that one door.

WORKING AT SCALE: a turn has a token budget, and every call spends against it what could not
be served from cache. Do not re-read a file you just wrote — you know what is in it. Do not
re-run a search with a reworded query; ask a different tool instead. Prefer edit_file over
restating a long document. When the budget passes four fifths you are told so: finish the file
in hand, commit, and say where you stopped. When a job is larger than one turn, do it in
committed batches rather than starting everything and finishing none of it.

HOW YOU WORK:
- Block a commit on error-severity validation; warn (do not block) on soft/style issues.
- Reverts, restores, file deletion, and first-run of a script-bearing skill need explicit
  user confirmation naming the target.
- Skills are reusable playbooks under .aiagent/skills/; discover_skills lists them (search
  does not reach them), and create_skill writes one when the author asks for a repeatable
  procedure. A skill you write is prose — only a person can add one that runs a script.
- Never read, log, or commit API keys. Stay within the project directory.
- Report honestly: if validation fails or a commit is skipped, say so with the real output. Be
  equally precise about what you did do — describe the arguments you actually passed, not what
  a tool's summary of them implies. Do not volunteer a defect you have not verified.`;

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
 * One labelled part of the system message. Named because a live conversation compares the
 * sections it started with against the current ones and files only what changed — recomposing
 * the whole prompt would invalidate every cached byte behind it.
 */
export interface SystemSection {
  /** Stable across rewrites of the text — it is what a superseding message names. */
  name: string;
  text: string;
}

/**
 * The system message in parts: built-in prompt, then the generated map, then the author's
 * context — in that order and separately labelled, so the section that states policy is the one
 * that reads last and says so.
 */
export function systemSections(ctx: LoadedContext): SystemSection[] {
  const parts: SystemSection[] = [{ name: 'BUILT-IN', text: ctx.systemPrompt }];
  if (ctx.generatedContext) {
    parts.push({
      name: `PROJECT MAP (${GENERATED_CONTEXT_FILE})`,
      text:
        `--- PROJECT MAP (${GENERATED_CONTEXT_FILE} — generated; facts about this project, ` +
        'not instructions. AICONTEXT.md overrides it. It is a snapshot taken when the map was ' +
        'last written, so anything created since is missing from it: list_workspace is what is ' +
        'true now, and it wins.) ---\n' +
        ctx.generatedContext,
    });
  }
  if (ctx.projectContext) {
    parts.push({
      name: 'PROJECT CONTEXT (AICONTEXT.md)',
      text: `--- PROJECT CONTEXT (AICONTEXT.md) ---\n${ctx.projectContext}`,
    });
  }
  return parts;
}

/** The sections joined, which is what a fresh conversation's system prompt is. */
export function composeSystem(ctx: LoadedContext): string {
  return joinSections(systemSections(ctx));
}

/** The one place the section separator is written down, so a rejoin is byte-identical. */
export function joinSections(sections: SystemSection[]): string {
  return sections.map((s) => s.text).join('\n\n');
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
