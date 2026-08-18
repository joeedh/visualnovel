/**
 * The tool registry (authoring-agent plan §6.3, report §7). Each tool is a thin, typed
 * shim over an already-existing function in the deterministic packages — nothing here
 * re-implements parsing, validation, or serialization. A tool declares whether it is
 * `mutating` (writes files / history) and whether it always needs explicit confirmation;
 * the loop's plan-mode gate (M3) reads those flags. Tools never decide policy themselves.
 */
import { join, relative } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { z, type ZodType } from 'zod';
import {
  applyCharacterEdit,
  applyLocationEdit,
  computeReachable,
  newCharacterDoc,
  newCharacterTemplate,
  newLocationDoc,
  successors,
  toMermaid,
  type CharacterEdit,
  type LocationEdit,
} from '@vn/model';
import { docToMarkdown } from '@vn/model';
import { formatExcerpts } from '@vn/bible';
import {
  deleteLine,
  deleteScene,
  insertLine,
  insertLines,
  mergeScene,
  moveLine,
  newScene,
  removeChoice,
  setChoice,
  setHeading,
  setLineText,
  setNext,
  setSpeaker,
  spliceScene,
  splitScene,
  type BranchOp,
  type LineOp,
  type SceneMap,
  type ScriptState,
} from '@vn/scriptedit';
import {
  applyMarkerPlan,
  applyScenePlan,
  planMarkerEdit,
  planSceneEdit,
  scenePlanMessage,
} from '@vn/scriptedit/write';
import { loadConfig } from '@vn/config';
import {
  AssetStore,
  guardedDir,
  readDocFile,
  readShots,
  resolveInWorkspace,
  workspacePath,
  writeDocFile,
  writeShots,
} from '@vn/store';
import { exists, readText, writeFileAtomic } from '@vn/util';
import { bindsTo, type Asset, type Diagnostic, type ProjectModel, type Shot } from '@vn/types';
import type { Git } from '@vn/git';
import {
  assetSlotLabel,
  formatSubject,
  parseSubject,
  rungsFor,
  setArtNotes,
  type NotesMode,
} from '@vn/artgen';
import type { ArtGen } from './art.js';
import { listArchive } from './archive.js';
import { updateContext } from './context.js';
import { formatIndex, Workspace } from './workspace.js';
import { discoverSkills, runSkill, skillRoots } from './skills.js';

/** What a tool returns: a text observation for the loop + optional structured data. */
export interface ToolResult {
  ok: boolean;
  /** Human/agent-readable observation. */
  output: string;
  /** Structured payload (consumed by the app, ignored by the ReAct loop). */
  data?: unknown;
  /** Workspace-relative paths this tool wrote (for commit staging). */
  written?: string[];
}

/**
 * Re-rendering a planned picture, as an injected capability. Deliberately not the scheduler: two
 * acts, queue and run, which is all an agent has any business asking for.
 */
export interface PipelineControl {
  /** Put an asset's task back to `pending`. Refuses a concept, an upload, and an orphaned task. */
  regenerate(hash: string): Promise<{ ok: boolean; message: string; written: string[] }>;
  /** Run the pipeline to completion, as `vngen run` would. */
  run(): Promise<{ ran: number; failed: number; blockedOnGate: boolean }>;
}

/**
 * What the agent was last shown of each workspace file, keyed by workspace-relative path: the hash
 * it read at, and whether it saw all of it. It is a record of the conversation, not of the disk —
 * nothing watches the filesystem, and a write compares a fresh read against what is written here.
 */
export type ReadLedger = Map<string, { hash: string; whole: boolean }>;

/** Execution context handed to every tool. */
export interface ToolContext {
  workspace: Workspace;
  git: Git;
  /**
   * The read ledger, owned by the agent loop and cleared with the conversation. Absent in bare
   * contexts, in which case `edit_file` refuses — an edit against a file nobody read is a guess.
   */
  seen?: ReadLedger;
  /**
   * Ask the host to confirm an irreversible/elevated action (e.g. running a script-bearing
   * skill). Wired by the agent loop to the permission gate; absent in bare contexts, in
   * which case elevated tools refuse rather than assume consent.
   */
  confirm?: (message: string) => Promise<boolean>;
  /** Extra directories to scan for skills, beyond the workspace's `.aiagent/skills`. */
  skillDirs?: string[];
  /**
   * Image generation, wired by the host that knows whether this run is mocked and where the keys
   * are. Absent in bare contexts, in which case `generate_image` and `edit_image` refuse rather
   * than assume an API key exists to spend.
   */
  art?: ArtGen;
  /**
   * Re-rendering a planned asset, wired by the host that owns the pipeline. `@vn/authoring` may
   * not import `@vn/pipeline` or `@vn/scheduler`, and this is why it does not have to: absent —
   * as it is in the REPL — `regenerate_asset` refuses and names the host that can.
   */
  pipeline?: PipelineControl;
}

/** A registered tool: a typed, gated shim over a reused function. */
export interface Tool<A = unknown> {
  name: string;
  description: string;
  /** True if the tool writes files or git history (rejected in plan mode). */
  mutating: boolean;
  /** True if the tool always needs explicit user confirmation (revert/restore/delete). */
  confirm?: boolean;
  args: ZodType<A>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

const ok = (output: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  output,
  ...extra,
});
const fail = (output: string): ToolResult => ({ ok: false, output });

const rel = (root: string, abs: string): string => relative(root, abs).replace(/\\/g, '/');

function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return 'No diagnostics. Inputs are valid.';
  return diags
    .map((d) => `[${d.severity}] ${d.code}${d.where ? ` (${d.where})` : ''}: ${d.message}`)
    .join('\n');
}

/** Render a zod base type as a short name for a tool-arg signature. */
function zodTypeName(t: ZodType): string {
  if (t instanceof z.ZodOptional || t instanceof z.ZodDefault || t instanceof z.ZodNullable)
    return zodTypeName(t._def.innerType as ZodType);
  if (t instanceof z.ZodArray) return `${zodTypeName(t._def.type as ZodType)}[]`;
  if (t instanceof z.ZodEnum) return (t._def.values as string[]).map((v) => `"${v}"`).join('|');
  if (t instanceof z.ZodString) return 'string';
  if (t instanceof z.ZodNumber) return 'number';
  if (t instanceof z.ZodBoolean) return 'boolean';
  if (t instanceof z.ZodObject) return 'object';
  return 'any';
}

/**
 * Render an object schema as a compact `name?: type (note)` signature so the model knows a
 * tool's argument names and intent instead of guessing them. Returns '' for non-objects.
 * Without this the model omits fields it can't name — e.g. a character's prose `description`.
 */
export function describeToolParams(schema: ZodType): string {
  if (!(schema instanceof z.ZodObject)) return '';
  const shape = schema.shape as Record<string, ZodType>;
  return Object.entries(shape)
    .map(([name, field]) => {
      const optional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
      const note = field.description ? ` (${field.description})` : '';
      return `${name}${optional ? '?' : ''}: ${zodTypeName(field)}${note}`;
    })
    .join(', ');
}

// ── File & content ──────────────────────────────────────────────────────────

const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description: 'Read a workspace file, optionally a line range.',
  mutating: false,
  args: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
  async run(a, ctx) {
    // Bounded, text-only, outside-the-workspace refused: the same read `doc.read` performs, so a
    // file too large to hand a human is also one the agent does not paste into its context.
    const read = await readDocFile(ctx.workspace.root, a.path);
    if (!read.ok) return fail(read.reason);
    const text = read.file.text;
    const whole = a.offset === undefined && a.limit === undefined;
    // The one respect in which reading is not pure: it records what was shown, so `edit_file` can
    // refuse an edit made against a file this conversation never saw. The output is unchanged.
    ctx.seen?.set(read.file.path, { hash: read.file.hash, whole });
    if (whole) return ok(text, { data: text });
    const lines = text.split('\n');
    const start = Math.max(0, a.offset ?? 0);
    const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
    return ok(slice.join('\n'), { data: slice });
  },
};

const listWorkspaceTool: Tool<Record<string, never>> = {
  name: 'list_workspace',
  description: 'List the characters, locations, and scenes that exist (a cheap index).',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const index = await ctx.workspace.index();
    return ok(formatIndex(index), { data: index });
  },
};

const INPUT_GLOBS = ['characters', 'locations', 'scenes', 'screenplay'];

/** What `search` walks, said once so the description and the no-match sentence cannot disagree. */
const SEARCH_SCOPE = `${INPUT_GLOBS.map((g) => `${g}/`).join(', ')}, AICONTEXT.md and project.yaml`;

/** Recursively collect text input files under the workspace's authored directories. */
async function collectInputFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (!(await exists(dir))) return;
    for (const e of await nodeFs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(md|fountain|markdown|yaml|yml|txt)$/i.test(e.name)) out.push(p);
    }
  };
  for (const g of INPUT_GLOBS) await walk(join(root, g));
  for (const name of ['AICONTEXT.md', 'project.yaml']) {
    const p = join(root, name);
    if (await exists(p)) out.push(p);
  }
  return out;
}

const searchTool: Tool<{ query: string; regex?: boolean }> = {
  name: 'search',
  description:
    'Search the authored inputs for a string or regex; returns file:line matches. Its scope is ' +
    `${SEARCH_SCOPE} — the story bible (wiki/) and archive/ are searched by search_bible and ` +
    'list_archive instead.',
  mutating: false,
  args: z.object({ query: z.string().min(1), regex: z.boolean().optional() }),
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = a.regex ? new RegExp(a.query, 'i') : new RegExp(escapeRegExp(a.query), 'i');
    } catch (err) {
      return fail(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const files = await collectInputFiles(ctx.workspace.root);
    const matches: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const lines = (await readText(file)).split('\n');
      lines.forEach((text, i) => {
        if (re.test(text))
          matches.push({ file: rel(ctx.workspace.root, file), line: i + 1, text: text.trim() });
      });
    }
    if (matches.length === 0) {
      // A negative result that says what it looked at is a redirect; one that does not is a dead
      // end, and the agent that reads it concludes the fact is nowhere in the project.
      return ok(
        `No matches for "${a.query}" in ${SEARCH_SCOPE}. The story bible (wiki/) and archive/ ` +
          'are not searched — try search_bible or list_archive.',
        { data: [] },
      );
    }
    const body = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
    return ok(body, { data: matches });
  },
};

const listArchiveTool: Tool<Record<string, never>> = {
  name: 'list_archive',
  description:
    'List documents the author uploaded to archive/. They are not in search or the bible — ' +
    'read one with read_file once you know its path.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const batches = await listArchive(ctx.workspace);
    if (batches.length === 0) return ok('The archive is empty.', { data: [] });
    const body = batches
      .map((b) => [`${b.dir}/`, ...b.files.map((f) => `  ${f.path} (${f.bytes} bytes)`)].join('\n'))
      .join('\n');
    return ok(body, { data: batches });
  },
};

const searchBibleTool: Tool<{ query: string; limit?: number }> = {
  name: 'search_bible',
  description:
    'Search the story bible (wiki/) for relevant passages; returns ranked file:line excerpts. ' +
    'The paths it reports are workspace-relative, so a hit can be handed straight to read_file.',
  mutating: false,
  args: z.object({
    query: z.string().min(1).describe('what you want to know, in words'),
    limit: z.number().optional().describe('most excerpts to return, default 8'),
  }),
  async run(a, ctx) {
    const bible = await ctx.workspace.bible();
    const excerpts = await bible.query(a.query, a.limit === undefined ? {} : { limit: a.limit });
    if (excerpts.length === 0)
      return ok(`Nothing in the bible matches "${a.query}".`, { data: [] });
    // The bible numbers its files from its own root, which is a path read_file cannot resolve.
    // Prefixing here rather than in `@vn/bible` keeps the excerpt what it is and the citation
    // usable: a hit is now something to paste, not something to reconstruct.
    const wiki = rel(ctx.workspace.root, ctx.workspace.paths.wikiDir);
    const cited = excerpts.map((e) => ({ ...e, file: `${wiki}/${e.file}` }));
    return ok(formatExcerpts(cited), { data: cited });
  },
};

// ── Domain / validation ─────────────────────────────────────────────────────

const validateInputsTool: Tool<Record<string, never>> = {
  name: 'validate_inputs',
  description: 'Validate schema conformance and cross-file invariants; report diagnostics.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const { model } = await ctx.workspace.load();
    const result = ok(formatDiagnostics(model.diagnostics), { data: model.diagnostics });
    result.ok = !model.diagnostics.some((d) => d.severity === 'error');
    return result;
  },
};

const parseFountainTool: Tool<Record<string, never>> = {
  name: 'parse_fountain',
  description: 'Parse the screenplay into scenes with their ids, choices, and linear next.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const { model } = await ctx.workspace.load();
    const scenes = [...model.scenes.values()].map((s) => ({
      id: s.id,
      location: s.location,
      characters: s.characters,
      choices: s.choices,
      next: s.next,
      synopsis: s.synopsis,
    }));
    const body = scenes
      .map(
        (s) =>
          `${s.id} @${s.location}${s.characters.length ? ` [${s.characters.join(', ')}]` : ''}` +
          s.choices.map((c) => `\n    -> ${c.goto} "${c.label}"`).join('') +
          (s.next ? `\n    -> ${s.next} (next)` : ''),
      )
      .join('\n');
    return ok(body || '(no scenes)', { data: scenes });
  },
};

const storyGraphTool: Tool<Record<string, never>> = {
  name: 'story_graph',
  description: 'Build the branch graph; report unreachable scenes and dangling targets.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const { model } = await ctx.workspace.load();
    const reachable = computeReachable(model.scenes, model.entry);
    const unreachable = [...model.scenes.keys()].filter((id) => !reachable.has(id));
    const dangling: string[] = [];
    for (const scene of model.scenes.values()) {
      for (const next of successors(scene)) {
        if (!model.scenes.has(next)) dangling.push(`${scene.id} -> ${next}`);
      }
    }
    const mermaid = toMermaid(model);
    const summary = [
      mermaid,
      '',
      `Entry: ${model.entry ?? '(none)'}`,
      `Unreachable: ${unreachable.length ? unreachable.join(', ') : 'none'}`,
      `Dangling: ${dangling.length ? dangling.join(', ') : 'none'}`,
    ].join('\n');
    return ok(summary, { data: { mermaid, unreachable, dangling, entry: model.entry } });
  },
};

const extractEntitiesTool: Tool<Record<string, never>> = {
  name: 'extract_entities',
  description: 'Compare characters/locations referenced in the screenplay vs. defined.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const { model } = await ctx.workspace.load();
    const definedChars = new Set(model.characters.keys());
    const referencedChars = new Set<string>();
    const referencedLocs = new Set<string>();
    for (const s of model.scenes.values()) {
      s.characters.forEach((c) => referencedChars.add(c));
      referencedLocs.add(s.location);
    }
    const userLocations = new Set(
      [...model.locations.values()].filter((l) => !l.mined).map((l) => l.id),
    );
    const unusedChars = [...definedChars].filter((c) => !referencedChars.has(c));
    const unusedLocs = [...userLocations].filter((l) => !referencedLocs.has(l));
    const data = {
      definedCharacters: [...definedChars],
      referencedCharacters: [...referencedChars],
      unusedCharacters: unusedChars,
      unusedLocations: unusedLocs,
    };
    const body = [
      `Characters defined: ${data.definedCharacters.join(', ') || 'none'}`,
      `Characters referenced: ${data.referencedCharacters.join(', ') || 'none'}`,
      `Defined but unused characters: ${unusedChars.join(', ') || 'none'}`,
      `Defined but unused locations: ${unusedLocs.join(', ') || 'none'}`,
    ].join('\n');
    return ok(body, { data });
  },
};

// ── Editing (execute mode) ──────────────────────────────────────────────────

const characterEditShape = z.object({
  id: z.string().min(1).describe('id of the character to edit'),
  name: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe('full prose body — the canonical description fed to the pipeline; replaces it whole'),
  status: z.enum(['draft', 'candidates', 'approved', 'locked']).optional(),
  defaultOutfit: z
    .string()
    .optional()
    .describe('outfit id worn wherever nothing else says otherwise; must be one of `outfits`'),
  outfits: z
    .record(
      z.union([
        z.string(),
        z.object({ description: z.string().optional(), art_notes: z.string().optional() }),
      ]),
    )
    .optional()
    .describe(
      'the whole wardrobe, outfit id → description (or {description, art_notes} for one that needs its own art direction); replaces the map, so send the ones being kept too',
    ),
  traits: z.array(z.string()).optional(),
  palette: z.array(z.string()).optional().describe('hex colors, e.g. #1a2a44'),
  artNotes: z
    .string()
    .optional()
    .describe(
      'art direction appended to every prompt this character reaches — how the art should look, not who the character is; empty string removes it',
    ),
});

const editCharacterTool: Tool<z.infer<typeof characterEditShape>> = {
  name: 'edit_character',
  description:
    "Apply a validated edit to an existing character.md and write it back. `artNotes` (and an outfit's `art_notes`) is how an author tweaks the look of generated art: it goes into the prompt, so changing it re-renders the portrait and model sheets it reaches on the next run. Say so before proposing one.",
  mutating: true,
  args: characterEditShape,
  async run(a, ctx) {
    const found = await ctx.workspace.characterDoc(a.id);
    if (!found) return fail(`no such character: ${a.id}`);
    const { id: _id, ...edit } = a;
    const res = applyCharacterEdit(found.doc, edit as CharacterEdit);
    if (!res.ok) return fail(`edit rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(found.file, docToMarkdown(res.value.doc));
    return ok(`Updated character ${a.id}.`, {
      written: [rel(ctx.workspace.root, found.file)],
      data: res.value.value,
    });
  },
};

const locationEditShape = z.object({
  id: z.string().min(1).describe('id of the location to edit'),
  name: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe('full prose body — the canonical description fed to the pipeline; replaces it whole'),
  mood: z.string().optional(),
  lighting: z.string().optional(),
  palette: z.array(z.string()).optional().describe('hex colors, e.g. #1a2a44'),
  variants: z
    .array(
      z.union([
        z.string(),
        z.object({
          id: z.string().min(1),
          description: z.string().optional(),
          art_notes: z.string().optional(),
        }),
      ]),
    )
    .optional()
    .describe(
      'the whole variant list, a bare id or {id, description, art_notes} for one that needs its own art direction; replaces the list',
    ),
  artNotes: z
    .string()
    .optional()
    .describe(
      'art direction appended to every plate of this location — how the art should look, not what the place is; empty string removes it',
    ),
});

const editLocationTool: Tool<z.infer<typeof locationEditShape>> = {
  name: 'edit_location',
  description:
    "Apply a validated edit to an existing location.md and write it back. `artNotes` (and a variant's `art_notes`) is how an author tweaks the look of generated art: it goes into the prompt, so changing it re-renders the plates it reaches on the next run. Say so before proposing one.",
  mutating: true,
  args: locationEditShape,
  async run(a, ctx) {
    const found = await ctx.workspace.locationDoc(a.id);
    if (!found) return fail(`no such location: ${a.id}`);
    const { id: _id, ...edit } = a;
    const res = applyLocationEdit(found.doc, edit as LocationEdit);
    if (!res.ok) return fail(`edit rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(found.file, docToMarkdown(res.value.doc));
    return ok(`Updated location ${a.id}.`, {
      written: [rel(ctx.workspace.root, found.file)],
      data: res.value.value,
    });
  },
};

/**
 * A create tool takes exactly what its `edit_*` sibling takes, minus the `id` it is about to
 * allocate — because the alternative is what the agent actually did: hand-write the sheet in raw
 * YAML through `write_file`, since the tool that owned the directory could only be told a name.
 */
const characterCreateShape = characterEditShape.omit({ id: true }).extend({
  name: z.string().min(1).describe('the display name; the id is slugged from it'),
});
const locationCreateShape = locationEditShape.omit({ id: true }).extend({
  name: z.string().min(1).describe('the display name; the id is slugged from it'),
});

/** What a create tool just made, said in the terms it was asked in. */
const createdHow = (description: string | undefined, fields: string[]): string => {
  const set = fields.length > 0 ? ` with ${fields.join(', ')} set` : '';
  if (description) return `from the description you gave${set}`;
  if (fields.length > 0)
    return (
      `with${set.slice(5)}, and no description — its body is empty, so there is nothing yet ` +
      'for the image model to draw from'
    );
  return (
    'as an empty template — no description was given, so its body is placeholders for someone ' +
    'who knows it to fill in'
  );
};

/** The fields a create call actually carried, in schema order, for both the edit and the report. */
const givenFields = <T extends object>(rest: T): [string, unknown][] =>
  Object.entries(rest).filter(([, v]) => v !== undefined);

const createCharacterTool: Tool<z.infer<typeof characterCreateShape>> = {
  name: 'create_character',
  description:
    'Scaffold a new characters/<id>/character.md. Takes every field edit_character takes, so a ' +
    'character known in full is written in one call rather than created and then edited. Given ' +
    'nothing but a name it writes a template of placeholders for the author to fill in; the ' +
    'result says which of the two it wrote.',
  mutating: true,
  args: characterCreateShape,
  async run(a, ctx) {
    const { name, description, ...rest } = a;
    const given = givenFields(rest);
    const doc = newCharacterDoc(name, description ?? '');
    const id = String(doc.data['id']);
    if (!id) return fail(`"${name}" does not name a character`);
    const file = ctx.workspace.paths.characterFile(id);
    if (await exists(file)) return fail(`character ${id} already exists`);

    // Told nothing, it is the template, whose placeholders are there to be edited by whoever knows
    // the character — which is not us. Told anything, the fields go through `applyCharacterEdit`,
    // so a created sheet is validated by exactly what would have validated an edited one.
    let text = newCharacterTemplate(name);
    if (description || given.length > 0) {
      const res = applyCharacterEdit(doc, Object.fromEntries(given) as CharacterEdit);
      if (!res.ok) return fail(`rejected: ${res.diagnostic.message}`);
      text = docToMarkdown(res.value.doc);
    }
    await writeFileAtomic(file, text);
    // Which of the three it did, in the observation rather than only in the file. A uniform
    // "Created" is what lets a later turn call a written sheet a placeholder and rewrite it.
    return ok(
      `Created character ${id} ${createdHow(
        description,
        given.map(([k]) => k),
      )}.`,
      { written: [rel(ctx.workspace.root, file)], data: { id } },
    );
  },
};

const createLocationTool: Tool<z.infer<typeof locationCreateShape>> = {
  name: 'create_location',
  description:
    'Scaffold a new locations/<id>.md. Takes every field edit_location takes, so a location known ' +
    'in full is written in one call rather than created and then edited. Given nothing but a name ' +
    'it is an empty sheet for the author to fill in; the result says which of the two it wrote.',
  mutating: true,
  args: locationCreateShape,
  async run(a, ctx) {
    const { name, description, ...rest } = a;
    const given = givenFields(rest);
    const doc = newLocationDoc(name, description ?? '');
    const id = String(doc.data['id']);
    if (!id) return fail(`"${name}" does not name a location`);
    const file = ctx.workspace.paths.locationFile(id);
    if (await exists(file)) return fail(`location ${id} already exists`);

    const res = applyLocationEdit(doc, Object.fromEntries(given) as LocationEdit);
    if (!res.ok) return fail(`rejected: ${res.diagnostic.message}`);
    await writeFileAtomic(file, docToMarkdown(res.value.doc));
    return ok(
      `Created location ${id} ${createdHow(
        description,
        given.map(([k]) => k),
      )}.`,
      { written: [rel(ctx.workspace.root, file)], data: { id } },
    );
  },
};

// ── Scene prose (execute mode) ──────────────────────────────────────────────

/**
 * The eleven acts, named exactly as the desktop's `story.*` commands are, because they *are* those
 * commands' decisions: an agent transcript and a command history should read as the same vocabulary.
 * `insertLines` is the twelfth and has no button behind it — a person types one line at a time and
 * a model drafts forty, and `@vn/scriptedit` still allocates every id.
 */
const SCENE_OPS = [
  'setLineText',
  'insertLine',
  'insertLines',
  'deleteLine',
  'moveLine',
  'moveShot',
  'setSpeaker',
  'newScene',
  'setHeading',
  'deleteScene',
  'splitScene',
  'mergeScene',
] as const;

type SceneOp = (typeof SCENE_OPS)[number];

const LINE_KINDS = [
  'dialogue',
  'parenthetical',
  'narration',
  'transition',
  'lyric',
  'centered',
] as const;

const sceneEditShape = z.object({
  op: z.enum(SCENE_OPS).describe('which act; the arguments each one needs are listed below'),
  scene: z
    .string()
    .optional()
    .describe('insertLine, moveShot, newScene, setHeading, deleteScene, splitScene, mergeScene'),
  line: z.string().optional().describe('a line id like arrival:L3 — the four line edits'),
  shot: z.string().optional().describe('moveShot: the shot id to move, e.g. arrival__beat1'),
  text: z.string().optional().describe('setLineText, insertLine'),
  lines: z
    .array(
      z.object({
        kind: z.enum(LINE_KINDS).optional().describe('defaults to dialogue'),
        speaker: z.string().optional().describe('the character cue; omit for narration'),
        text: z.string().min(1),
      }),
    )
    .optional()
    .describe('insertLines: a run of lines to add in order, each after the one before it'),
  after: z
    .string()
    .optional()
    .describe(
      'insertLine, moveLine: the line to sit after; moveShot: the shot to sit after; ' +
        'omit for the top of the scene',
    ),
  kind: z.enum(LINE_KINDS).optional().describe('insertLine; defaults to dialogue'),
  speaker: z
    .string()
    .optional()
    .describe('insertLine, setSpeaker: the character cue; empty makes the line narration'),
  heading: z
    .string()
    .optional()
    .describe(
      'newScene, setHeading: e.g. INT. CLASSROOM - EVENING. setHeading moves the scene, so its ' +
        'rendered shots are drawn again and its prose is left describing the old place',
    ),
  at: z.string().optional().describe('splitScene: the line id that starts the second half'),
  into: z.string().optional().describe('splitScene: the new scene id; mergeScene: the absorber'),
});

type SceneEditArgs = z.infer<typeof sceneEditShape>;

/**
 * What each op cannot be attempted without. Only *absence* is checked here — whether a line may be
 * empty, whether a dialogue line needs a speaker, whether a scene may be deleted are all judgments
 * `@vn/scriptedit` already makes, and making them twice is how two answers start to disagree.
 */
const SCENE_OP_ARGS: Record<SceneOp, readonly (keyof SceneEditArgs)[]> = {
  setLineText: ['line', 'text'],
  insertLine: ['scene', 'text'],
  insertLines: ['scene', 'lines'],
  deleteLine: ['line'],
  moveLine: ['line'],
  moveShot: ['scene', 'shot'],
  setSpeaker: ['line'],
  newScene: ['scene', 'heading'],
  setHeading: ['scene', 'heading'],
  deleteScene: ['scene'],
  splitScene: ['scene', 'at', 'into'],
  mergeScene: ['scene', 'into'],
};

/**
 * The one `@vn/scriptedit` decision an op names, with the tool's defaults filled in. Async only
 * because `moveShot`'s rule needs the scene's storyboard, which is read off disk; the other ten
 * are pure and resolve immediately.
 */
async function sceneDecider(
  a: SceneEditArgs,
  workspace: Workspace,
): Promise<(state: ScriptState) => LineOp> {
  const scene = a.scene ?? '';
  const line = a.line ?? '';
  const text = a.text ?? '';
  const after = a.after ?? '';
  const speaker = a.speaker ?? '';
  const into = a.into ?? '';
  switch (a.op) {
    case 'setLineText':
      return (s) => setLineText(s, { line, text });
    case 'insertLine':
      return (s) => insertLine(s, { scene, after, kind: a.kind ?? 'dialogue', speaker, text });
    case 'insertLines':
      return (s) =>
        insertLines(s, {
          scene,
          after,
          lines: (a.lines ?? []).map((l) => ({
            kind: l.kind ?? 'dialogue',
            speaker: l.speaker ?? '',
            text: l.text,
          })),
        });
    case 'deleteLine':
      return (s) => deleteLine(s, { line });
    case 'moveLine':
      return (s) => moveLine(s, { line, after });
    case 'moveShot':
      return workspace.shotOrder(scene, a.shot ?? '', after);
    case 'setSpeaker':
      return (s) => setSpeaker(s, { line, speaker });
    case 'newScene':
      return (s) => newScene(s, { scene, heading: a.heading ?? '' });
    case 'setHeading':
      return (s) => setHeading(s, { scene, heading: a.heading ?? '' });
    case 'deleteScene':
      return (s) => deleteScene(s, { scene });
    case 'splitScene':
      return (s) => splitScene(s, { scene, at: a.at ?? '', into });
    case 'mergeScene':
      return (s) => mergeScene(s, { scene, into });
  }
}

/**
 * The agent's one prose write path, over the same decisions the palette and the branch editor run.
 * It exists so that `vnauthor` is not the writer that goes around them: a whole-file overwrite can
 * duplicate line ids and strand storyboards, and nothing downstream would notice.
 */
const editSceneTool: Tool<SceneEditArgs> = {
  name: 'edit_scene',
  description:
    'Edit scene prose: retype, insert, delete, move or re-attribute a line; create, delete, ' +
    'split or merge a scene; reorder a shot, which moves the lines it covers. The only way to ' +
    'change a scenes/<id>.md — write_file refuses them. Reports what the edit costs the ' +
    'storyboard; moveShot costs it nothing, since no coverage and no covered prose changes. ' +
    'newScene leaves the scene unreachable on purpose: follow it with edit_branches to link it in. ' +
    'Drafting a run of prose is insertLines, one call for the whole run — do not call insertLine ' +
    'forty times.',
  mutating: true,
  args: sceneEditShape,
  async run(a, ctx) {
    const missing = SCENE_OP_ARGS[a.op].filter((name) => a[name] === undefined);
    if (missing.length > 0) return fail(`${a.op} needs: ${missing.join(', ')}`);

    const input = await ctx.workspace.sceneEditInput();
    const plan = await planSceneEdit(input, await sceneDecider(a, ctx.workspace));
    if (!plan.ok) return fail(plan.message);

    const { written, removed } = await applyScenePlan(input, plan);
    const paths = [...written, ...removed].map((file) => rel(ctx.workspace.root, file));
    return ok(scenePlanMessage(plan), { written: paths, data: { paths, fallout: plan.fallout } });
  },
};

// ── Branch wiring (execute mode) ────────────────────────────────────────────

const BRANCH_OPS = ['setChoice', 'removeChoice', 'setNext', 'spliceScene'] as const;

type BranchOpName = (typeof BRANCH_OPS)[number];

const branchEditShape = z.object({
  op: z.enum(BRANCH_OPS).describe('which rewire; the arguments each one needs are listed below'),
  scene: z
    .string()
    .min(1)
    .describe('the scene being wired; for spliceScene, the one going in the middle'),
  goto: z
    .string()
    .optional()
    .describe('setChoice: where the choice leads. setNext: the continuation; omit to clear it'),
  label: z.string().optional().describe('setChoice: what the player reads on the button'),
  index: z
    .number()
    .int()
    .optional()
    .describe('setChoice: which choice to replace, omit to append. removeChoice: which to drop'),
  from: z.string().optional().describe('spliceScene: the scene whose outgoing edge is being cut'),
  edge: z
    .number()
    .int()
    .optional()
    .describe("spliceScene: which of `from`'s choices to splice into; omit for its next"),
});

type BranchEditArgs = z.infer<typeof branchEditShape>;

/** As with {@link SCENE_OP_ARGS}, only *absence* is checked; the rules judge everything else. */
const BRANCH_OP_ARGS: Record<BranchOpName, readonly (keyof BranchEditArgs)[]> = {
  setChoice: ['goto', 'label'],
  removeChoice: ['index'],
  setNext: [],
  spliceScene: ['from'],
};

const branchDecider =
  (a: BranchEditArgs) =>
  (scenes: SceneMap): BranchOp => {
    const scene = a.scene;
    switch (a.op) {
      case 'setChoice':
        return setChoice(scenes, {
          scene,
          goto: a.goto ?? '',
          label: a.label ?? '',
          ...(a.index === undefined ? {} : { index: a.index }),
        });
      case 'removeChoice':
        return removeChoice(scenes, { scene, index: a.index ?? 0 });
      case 'setNext':
        return setNext(scenes, { scene, ...(a.goto === undefined ? {} : { goto: a.goto }) });
      case 'spliceScene':
        return spliceScene(scenes, {
          scene,
          from: a.from ?? '',
          ...(a.edge === undefined ? {} : { edge: a.edge }),
        });
    }
  };

/**
 * The agent's one way to say what leads where — the same `@vn/scriptedit` rules the branch editor
 * runs mid-drag, so a rewire it is refused is refused in the same sentence an author would read.
 *
 * It exists because `newScene` ends with *nothing points at it yet* and, until this tool, that was
 * a dead end: `write_file` refuses `scenes/`, `edit_scene` writes prose, and a scene nothing reaches
 * is a scene the story does not have. Creating one is deliberately still **two** acts rather than a
 * `goto` argument on `newScene` — where a new scene belongs is a separate authorial decision, and
 * `spliceScene` (put it *between* two scenes) is the answer often enough that folding one of the
 * four in would make the other three look optional.
 */
const editBranchesTool: Tool<BranchEditArgs> = {
  name: 'edit_branches',
  description:
    'Wire the story graph: add or replace a choice, drop one, set or clear a scene’s linear ' +
    'continuation, or splice a scene into an existing edge so A→B becomes A→C→B. This is how a ' +
    'scene created by edit_scene is linked in — until something points at it, the story never ' +
    'reaches it. A goto may name a scene that does not exist yet; that is a dangling edge the ' +
    'editor reports, not an error.',
  mutating: true,
  args: branchEditShape,
  async run(a, ctx) {
    const missing = BRANCH_OP_ARGS[a.op].filter((name) => a[name] === undefined);
    if (missing.length > 0) return fail(`${a.op} needs: ${missing.join(', ')}`);

    const { op, sources } = await ctx.workspace.branchEdit(branchDecider(a));
    if (!op.ok) return fail(op.error);

    const plan = planMarkerEdit(sources, op.edits);
    if (!plan.ok) return fail(plan.message);
    if (plan.patches.length === 0)
      return ok(`${op.message} (already wired that way — nothing written)`);

    const files = await applyMarkerPlan(plan.patches);
    const paths = files.map((file) => rel(ctx.workspace.root, file));
    return ok(op.message, { written: paths, data: { paths } });
  },
};

const outfitShape = z.object({
  scene: z.string().min(1).describe('the scene the change applies to'),
  character: z.string().min(1).describe('who is being dressed'),
  outfit: z
    .string()
    .describe('an outfit id from the character sheet, or "" to clear and inherit the level below'),
  shot: z
    .string()
    .optional()
    .describe('omit to mark the whole scene; name a shot to override that shot alone'),
});

/**
 * Both levels of the outfit chain in one tool, because they are one authorial sentence — "put Aiko
 * in her tracksuit for the club scene" and "...for this one frame" differ by a word, and the file
 * each lands in is a consequence, not a choice the author makes. `shot` picks the level: absent, a
 * `[[outfit:]]` marker is spliced into the scene chunk; present, the subject's override is written
 * to the storyboard, which re-hashes that shot.
 *
 * Both rules come from `@vn/scriptedit`, so a refusal here is verbatim the one `story.setOutfit` or
 * `story.setSceneOutfit` would give in the app.
 */
const setOutfitTool: Tool<z.infer<typeof outfitShape>> = {
  name: 'set_outfit',
  description:
    'Say what a character wears: for a whole scene (a [[outfit:]] marker) or for one shot of it ' +
    '(a subject override, which re-renders that frame). Pass outfit="" to clear either and let ' +
    'the level below answer. The wardrobe itself is authored on the character sheet.',
  mutating: true,
  args: outfitShape,
  async run(a, ctx) {
    if (a.shot !== undefined) {
      const op = await ctx.workspace.shotOutfit(a.scene, a.shot, a.character, a.outfit);
      if (!op.ok) return fail(op.error);
      await writeShots(ctx.workspace.paths, a.scene, op.shots);
      const shotsFile = `vngen/work/shots/${a.scene}.json`;
      return ok(op.message, { written: [shotsFile], data: { paths: [shotsFile] } });
    }

    const { op, sources } = await ctx.workspace.sceneOutfit(a.scene, a.character, a.outfit);
    if (!op.ok) return fail(op.error);

    const plan = planMarkerEdit(sources, op.edits);
    if (!plan.ok) return fail(plan.message);
    if (plan.patches.length === 0) return ok(`${op.message} (already so — nothing written)`);

    const files = await applyMarkerPlan(plan.patches);
    const paths = files.map((file) => rel(ctx.workspace.root, file));
    return ok(op.message, { written: paths, data: { paths } });
  },
};

/**
 * The validated writer a path belongs to, or null where nobody owns it. `guardedDir` answers for
 * `scenes/` on behalf of every surface; the two entity directories are this agent's own rule,
 * because a sheet hand-written as raw YAML is a sheet no schema ever saw.
 */
function ownedElsewhere(path: string): string | null {
  if (guardedDir(path)) return 'edit_scene';
  const top = path.split('/')[0];
  if (top === 'characters') return 'create_character / edit_character';
  if (top === 'locations') return 'create_location / edit_location';
  return null;
}

const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a workspace file, whole. Execute mode only. To change part of a file ' +
    'that already exists, use edit_file — an overwrite of a file this conversation has not read ' +
    'is refused. Never for scenes/ (edit_scene), characters/ or locations/ (their own tools).',
  mutating: true,
  args: z.object({ path: z.string(), content: z.string() }),
  async run(a, ctx) {
    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    const path = workspacePath(ctx.workspace.root, abs);
    const owner = ownedElsewhere(path);
    if (owner) return fail(`${path} is written by ${owner}, not write_file`);

    // No ledger entry means "I expect no file here", which is how a creation saves and how an
    // unread overwrite earns `already exists` instead of quietly replacing what it never read.
    const seen = ctx.seen?.get(path);
    const written = await writeDocFile(
      ctx.workspace.root,
      path,
      a.content,
      seen?.hash ?? '',
      'edit_scene',
    );
    if (!written.ok) return fail(written.reason);
    ctx.seen?.set(path, { hash: written.hash, whole: true });
    return ok(`Wrote ${path} (${written.bytes.toLocaleString()} bytes).`, { written: [path] });
  },
};

const CONTEXT_LINES = 3;

/** A quoted fragment, short enough to read in a refusal. */
function clip(text: string, max = 60): string {
  const oneLine = text.replace(/\n/g, '\\n');
  return oneLine.length <= max ? `"${oneLine}"` : `"${oneLine.slice(0, max)}…"`;
}

/** How many times `needle` occurs in `hay`, non-overlapping. */
function occurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * One change as the model reads it back: three lines of context each side, the old lines marked
 * `-` and the new ones `+`. Whole lines, not the matched fragment — a bare `- in spring` says
 * nothing about where it sat. Rendered against the text as it stood when that edit landed, which
 * is the only version whose line numbers mean anything. Returning the whole file instead would
 * hand back everything the tool exists to save, and a model shown a whole file tends to rewrite it.
 */
function renderHunk(
  text: string,
  index: number,
  edit: { old: string; new: string },
  ordinal: number,
  count: number,
): string {
  const lines = text.split('\n');
  const at = text.slice(0, index).split('\n').length - 1;
  // Widen the match out to line boundaries either side, so both halves read as lines of the file.
  const from = text.lastIndexOf('\n', index - 1) + 1;
  const after = index + edit.old.length;
  const breakAt = text.indexOf('\n', after);
  const to = breakAt === -1 ? text.length : breakAt;
  const removed = text.slice(from, to).split('\n');
  const added = (text.slice(from, index) + edit.new + text.slice(after, to)).split('\n');

  const head = lines.slice(Math.max(0, at - CONTEXT_LINES), at).map((l) => `  ${l}`);
  const past = at + removed.length;
  const tail = lines.slice(past, Math.min(lines.length, past + CONTEXT_LINES)).map((l) => `  ${l}`);
  const more = count > 1 ? ` (and ${count - 1} more like it)` : '';
  return [
    `@@ edit ${ordinal}, line ${at + 1}${more}`,
    ...head,
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
    ...tail,
  ]
    .join('\n')
    .trimEnd();
}

const editFileTool: Tool<{
  path: string;
  edits: { old: string; new: string; all?: boolean }[];
}> = {
  name: 'edit_file',
  description:
    'Replace exact strings in a workspace file, leaving the rest untouched — the way to change ' +
    'part of a long document without restating it. Each `old` must appear exactly once unless ' +
    '`all` is set. Read the file first: an edit to a file you have not read, or that changed ' +
    'since you read it, is refused. Not for scenes/ (edit_scene), characters/ or locations/ ' +
    '(their own tools).',
  mutating: true,
  args: z.object({
    path: z.string(),
    edits: z
      .array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }))
      .min(1),
  }),
  async run(a, ctx) {
    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    const path = workspacePath(ctx.workspace.root, abs);
    const owner = ownedElsewhere(path);
    if (owner) return fail(`${path} is written by ${owner}, not edit_file`);

    const seen = ctx.seen?.get(path);
    if (!seen) {
      return fail(
        `${path} has not been read this conversation — read_file it first, so an edit is made ` +
          'against what is actually there.',
      );
    }
    const read = await readDocFile(ctx.workspace.root, path);
    if (!read.ok) return fail(read.reason);
    if (read.file.hash !== seen.hash) {
      return fail(
        `${path} changed since you read it (read at ${seen.hash.slice(0, 12)}, now ` +
          `${read.file.hash.slice(0, 12)}) — read_file it again and reapply.`,
      );
    }

    // Every edit lands in memory first and the result is written once, so a refusal half-way
    // through leaves the file exactly as the model last read it and the call is safe to retry.
    const original = read.file.text;
    let text = original;
    const hunks: string[] = [];
    for (const [i, edit] of a.edits.entries()) {
      const found = occurrences(text, edit.old);
      if (found === 0) {
        return fail(
          `edit ${i + 1}: ${clip(edit.old)} does not appear in ${path} — matching is exact, ` +
            'including whitespace and indentation. Nothing was written.',
        );
      }
      if (found > 1 && !edit.all) {
        return fail(
          `edit ${i + 1}: ${clip(edit.old)} appears ${found} times in ${path} — extend it until ` +
            'it is unique, or pass all: true. Nothing was written.',
        );
      }
      const index = text.indexOf(edit.old);
      hunks.push(renderHunk(text, index, edit, i + 1, edit.all ? found : 1));
      text = edit.all
        ? text.split(edit.old).join(edit.new)
        : text.slice(0, index) + edit.new + text.slice(index + edit.old.length);
    }

    if (text === original) return ok(`${path} already reads exactly this way — nothing written.`);

    // The same writer the Wiki pane saves through, so front-matter that will not parse and a
    // dropped `type:` tag earn the same refusal here as they do there.
    const written = await writeDocFile(ctx.workspace.root, path, text, seen.hash, 'edit_scene');
    if (!written.ok) return fail(written.reason);
    ctx.seen?.set(path, { hash: written.hash, whole: seen.whole });

    const summary =
      `Edited ${path} — ${a.edits.length} change(s), ` +
      `${Buffer.byteLength(original, 'utf8').toLocaleString()} → ` +
      `${written.bytes.toLocaleString()} bytes.`;
    return ok(`${summary}\n\n${hunks.join('\n\n')}`, { written: [path] });
  },
};

const regenerateContextTool: Tool<Record<string, never>> = {
  name: 'regenerate_context',
  description:
    'Rebuild AICONTEXT.generated.md — the project map: the cast, the locations, the story graph, ' +
    "and the story bible's table of contents. Facts only; it never copies what a file says.",
  mutating: true,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const { file, counts } = await ctx.workspace.writeGeneratedContext();
    const summary =
      `${counts.characters} character(s), ${counts.locations} location(s), ` +
      `${counts.scenes} scene(s), ${counts.bible} bible note(s)`;
    return ok(`Regenerated the project map from ${summary}.`, {
      written: [rel(ctx.workspace.root, file)],
      data: counts,
    });
  },
};

const updateContextTool: Tool<{ rule: string }> = {
  name: 'update_context',
  description:
    'Persist a durable instruction into AICONTEXT.md. Returns the file as it now stands, so ' +
    'what you wrote is visible without reading it back.',
  mutating: true,
  args: z.object({ rule: z.string().min(1) }),
  async run(a, ctx) {
    const file = await updateContext(ctx.workspace.root, a.rule);
    // The file, not a receipt for it: the rule lands in a file the agent did not write in full,
    // and a receipt is exactly what makes the next call a read_file of what it just did.
    const text = await readText(file);
    return ok(`Recorded rule in AICONTEXT.md, which now reads:\n\n${text}`, {
      written: [rel(ctx.workspace.root, file)],
      data: text,
    });
  },
};

// ── Git ─────────────────────────────────────────────────────────────────────

const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the working-tree status.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const s = await ctx.git.status();
    const body = s.dirty ? s.entries.map((e) => `${e.x}${e.y} ${e.path}`).join('\n') : 'clean';
    return ok(`On ${s.branch}\n${body}`, { data: s });
  },
};

const gitLogTool: Tool<{ limit?: number }> = {
  name: 'git_log',
  description: 'Show recent commit history.',
  mutating: false,
  args: z.object({ limit: z.number().optional() }),
  async run(a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const log = await ctx.git.log(a.limit ?? 20);
    const body = log.map((c) => `${c.shortHash} ${c.date} ${c.subject}`).join('\n');
    return ok(body || '(no commits)', { data: log });
  },
};

const gitShowTool: Tool<{ ref: string }> = {
  name: 'git_show',
  description: 'Show a commit (metadata + patch).',
  mutating: false,
  args: z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    return ok(await ctx.git.show(a.ref));
  },
};

const gitDiffTool: Tool<{ ref?: string; staged?: boolean }> = {
  name: 'git_diff',
  description: 'Show a unified diff of the working tree (or against a ref).',
  mutating: false,
  args: z.object({ ref: z.string().optional(), staged: z.boolean().optional() }),
  async run(a, ctx) {
    const diff = await ctx.git.diff({ ref: a.ref, staged: a.staged });
    return ok(diff || '(no changes)', { data: diff });
  },
};

const gitCommitTool: Tool<{ message: string; paths?: string[] }> = {
  name: 'git_commit',
  description:
    'Stage and commit the approved change set with a message. Send the message alone: what you ' +
    'wrote this plan is already tracked, and a remembered list of paths can only be shorter.',
  mutating: true,
  args: z.object({
    message: z.string().min(1),
    paths: z
      .array(z.string())
      .optional()
      .describe('rarely needed: extra paths to commit beyond the ones you wrote'),
  }),
  async run(a, ctx) {
    if (!(await ctx.git.isRepo())) return fail('Not a git repository (offer git_init).');
    const hash = await ctx.git.commit({ message: a.message, paths: a.paths });
    return hash
      ? ok(`Committed ${hash.slice(0, 8)}: ${a.message}`, { data: hash })
      : ok('Nothing to commit.');
  },
};

const gitRevertTool: Tool<{ ref: string }> = {
  name: 'git_revert',
  description: 'Revert a commit (new commit undoing it). Always confirmed.',
  mutating: true,
  confirm: true,
  args: z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    await ctx.git.revert(a.ref);
    return ok(`Reverted ${a.ref}.`);
  },
};

const gitRestoreTool: Tool<{ path: string; ref?: string }> = {
  name: 'git_restore',
  description: 'Restore a file to an earlier commit. Always confirmed.',
  mutating: true,
  confirm: true,
  args: z.object({ path: z.string().min(1), ref: z.string().optional() }),
  async run(a, ctx) {
    await ctx.git.restore(a.path, a.ref ?? 'HEAD');
    return ok(`Restored ${a.path} to ${a.ref ?? 'HEAD'}.`);
  },
};

// ── Skills ────────────────────────────────────────────────────────────────────

const discoverSkillsTool: Tool<Record<string, never>> = {
  name: 'discover_skills',
  description: 'List available authoring skills (reusable playbooks) and when to use them.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    const skills = await discoverSkills(skillRoots(ctx.workspace.root, ctx.skillDirs));
    if (skills.length === 0) return ok('No skills found under .aiagent/skills.', { data: [] });
    const body = skills
      .map((s) => {
        const tags = [s.script ? 'script' : 'guide', s.whenToUse ? `when: ${s.whenToUse}` : '']
          .filter(Boolean)
          .join('; ');
        return `- ${s.id} "${s.name}" [${tags}]: ${s.description}`;
      })
      .join('\n');
    return ok(body, { data: skills.map((s) => ({ id: s.id, name: s.name, script: !!s.script })) });
  },
};

const runSkillTool: Tool<{ name: string }> = {
  name: 'run_skill',
  description:
    'Run a skill by id/name. Prose skills return guidance; script-bearing skills run only ' +
    'after explicit confirmation.',
  mutating: true,
  args: z.object({ name: z.string().min(1) }),
  async run(a, ctx) {
    const skills = await discoverSkills(skillRoots(ctx.workspace.root, ctx.skillDirs));
    const skill = skills.find((s) => s.id === a.name || s.name === a.name);
    if (!skill) return fail(`no such skill: ${a.name}`);
    const result = await runSkill(skill, {
      workspaceRoot: ctx.workspace.root,
      confirm: ctx.confirm,
    });
    return { ok: result.ok, output: result.output };
  },
};

const gitInitTool: Tool<Record<string, never>> = {
  name: 'git_init',
  description: 'Initialize a git repository in the workspace.',
  mutating: true,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    if (await ctx.git.isRepo()) return ok('Already a git repository.');
    await ctx.git.init();
    return ok('Initialized empty git repository.');
  },
};

const generateImageTool: Tool<{ sentence: string; subject?: string }> = {
  name: 'generate_image',
  description:
    'Draw a concept image from a sentence, e.g. "an aerial shot of the high school". It is bound to the location or character it names — say which, or let the sentence decide — and appears under Concepts in the project. A concept is a sketch and nothing more: the pipeline never plans it, no scene renders it, and `vngen export` ignores it; promoting one to a real location plate is a separate, human decision. It costs one image generation, so ask before drawing several.',
  mutating: true,
  confirm: true,
  args: z.object({
    sentence: z.string().min(1).describe('what to draw, in plain words'),
    subject: z
      .string()
      .optional()
      .describe('location:<id> or character:<id>; omitted means the sentence decides'),
  }),
  async run(a, ctx) {
    if (!ctx.art) {
      return fail('image generation is not available in this session; nothing was drawn.');
    }
    const subject = a.subject ? parseSubject(a.subject) : undefined;
    if (a.subject && !subject) {
      return fail(`"${a.subject}" is not a subject — write location:<id> or character:<id>.`);
    }
    try {
      const res = await ctx.art.generate({
        sentence: a.sentence,
        ...(subject ? { subject } : {}),
      });
      const file = rel(ctx.workspace.root, res.file);
      const of = res.subject
        ? ` of ${formatSubject(res.subject)}`
        : ' bound to nothing in the project';
      return ok(`Drew a concept${of}: ${file}. It is a sketch — nothing in the pipeline uses it.`, {
        written: [file, rel(ctx.workspace.root, ctx.workspace.paths.baseManifest)],
        data: {
          hash: res.ref.hash,
          file,
          prompt: res.prompt,
          ...(res.subject ? { subject: formatSubject(res.subject) } : {}),
        },
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const listImagesTool: Tool<Record<string, never>> = {
  name: 'list_images',
  description:
    'List the concept sketches this project holds: hash, name, what each is bound to, and the prompt it was drawn from. Read-only. Use it before `edit_image` — a concept is named by its hash, and this is where one comes from.',
  mutating: false,
  args: z.object({}).strict(),
  async run(_a, ctx) {
    if (!ctx.art) return fail('image generation is not available in this session.');
    const concepts = await ctx.art.list();
    if (concepts.length === 0) {
      return ok('No concept sketches yet. `generate_image` draws one from a sentence.');
    }
    const lines = concepts.map((c) => {
      const of = c.subject ? ` of ${formatSubject(c.subject)}` : '';
      return `${c.hash.slice(0, 12)}  ${c.title ?? '(unnamed)'}${of}\n  ${rel(ctx.workspace.root, c.file)}\n  prompt: ${c.prompt ?? '(none recorded)'}`;
    });
    return ok(`${concepts.length} concept sketch(es):\n${lines.join('\n')}`, {
      data: concepts.map((c) => ({
        hash: c.hash,
        ...(c.title ? { title: c.title } : {}),
        ...(c.prompt ? { prompt: c.prompt } : {}),
        ...(c.subject ? { subject: formatSubject(c.subject) } : {}),
      })),
    });
  },
};

const editImageTool: Tool<{ hash: string; prompt?: string; title?: string }> = {
  name: 'edit_image',
  description:
    'Draw a concept sketch again, from an edited prompt. A concept is the one asset whose prompt is authored rather than derived from the project, so it is the one prompt you may rewrite — pass the whole prompt, starting from the one `list_images` reports, so the style preamble and the framing line survive. The result is a NEW sketch beside the original; nothing is overwritten and nothing downstream sees either. Omitting the prompt re-rolls the recorded one, which is pointless when `image_params.seed` is fixed. It costs one image generation, so confirm with the author before drawing.',
  mutating: true,
  confirm: true,
  args: z.object({
    hash: z.string().min(4).describe('the concept to redraw; a hash prefix from list_images'),
    prompt: z
      .string()
      .optional()
      .describe('the whole prompt to draw from; omitted re-rolls the recorded one'),
    title: z.string().optional().describe('a new name for it; omitted keeps the one it has'),
  }),
  async run(a, ctx) {
    if (!ctx.art) {
      return fail('image generation is not available in this session; nothing was drawn.');
    }
    try {
      // A 64-char hash is passed straight through so `redrawConcept` can refuse a derived asset by
      // name; anything shorter is a prefix, and an ambiguous one is a question, not a guess.
      let hash = a.hash;
      if (hash.length < 64) {
        const matches = (await ctx.art.list()).filter((c) => c.hash.startsWith(hash));
        if (matches.length === 0) {
          return fail(`no concept starts with "${hash}" — run list_images to see what there is.`);
        }
        if (matches.length > 1) {
          return fail(
            `"${hash}" names ${matches.length} concepts (${matches.map((m) => m.hash.slice(0, 12)).join(', ')}); say more of the hash.`,
          );
        }
        hash = matches[0]!.hash;
      }

      const res = await ctx.art.redraw({
        hash,
        ...(a.prompt === undefined ? {} : { prompt: a.prompt }),
        ...(a.title === undefined ? {} : { title: a.title }),
      });
      const file = rel(ctx.workspace.root, res.file);
      const same = res.unchanged
        ? ' The same prompt and a fixed seed gave back the very same picture.'
        : ` ${res.from.slice(0, 12)} is still there.`;
      return ok(`Redrew ${res.from.slice(0, 12)} as ${file}.${same}`, {
        written: [file, rel(ctx.workspace.root, ctx.workspace.paths.baseManifest)],
        data: { hash: res.ref.hash, from: res.from, file, prompt: res.prompt },
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

// ── Planned art: what exists, how it was directed, and drawing it again ─────

/** What `list_assets` is asked about. The three things a picture in this project can be of. */
type AssetSubject = { characterId: string } | { locationId: string } | { sceneId: string };

/** Parse `character:aiko` / `location:cafe` / `scene:greet`; `undefined` for anything else. */
function parseAssetSubject(ref: string): AssetSubject | undefined {
  const cut = ref.indexOf(':');
  if (cut <= 0) return undefined;
  const id = ref.slice(cut + 1).trim();
  if (!id) return undefined;
  if (ref.startsWith('character:')) return { characterId: id };
  if (ref.startsWith('location:')) return { locationId: id };
  if (ref.startsWith('scene:')) return { sceneId: id };
  return undefined;
}

/** An asset named by hash or by a prefix of one. An ambiguous prefix is a question, not a guess. */
function findAsset(
  assets: readonly Asset[],
  said: string,
): { ok: true; asset: Asset } | { ok: false; error: string } {
  const hash = said.trim().toLowerCase();
  const matches = assets.filter((a) => a.hash === hash || a.hash.startsWith(hash));
  if (matches.length === 0) {
    return {
      ok: false,
      error: `no asset starts with "${said}" — run list_assets to see what there is.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${said}" names ${matches.length} assets (${matches.map((m) => m.hash.slice(0, 12)).join(', ')}); say more of the hash.`,
    };
  }
  return { ok: true, asset: matches[0]! };
}

/** The storyboards for the scenes named, in the shape `rungsFor` reads them. */
async function shotsFor(
  workspace: Workspace,
  model: ProjectModel,
  sceneIds: readonly string[],
): Promise<Map<string, readonly Shot[] | null>> {
  const shots = new Map<string, readonly Shot[] | null>();
  for (const id of sceneIds) {
    const scene = model.scenes.get(id);
    if (!scene) continue;
    const ids = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(workspace.paths, id, ids).catch(() => null);
    shots.set(id, loaded?.shots ?? null);
  }
  return shots;
}

const listAssetsTool: Tool<{ subject: string }> = {
  name: 'list_assets',
  description:
    "List the pictures the pipeline has rendered for one subject — character:<id>, location:<id> or scene:<id> — with each one's hash, what it is, its kind, and whether it is accepted. Read-only, and the way to name an asset before `art_notes`, `view_image` or `regenerate_asset`. Concept sketches are listed by `list_images` instead, and a picture the pipeline has not drawn yet has no hash and does not appear here.",
  mutating: false,
  args: z.object({
    subject: z.string().min(1).describe('character:<id>, location:<id> or scene:<id>'),
  }),
  async run(a, ctx) {
    const subject = parseAssetSubject(a.subject);
    if (!subject) {
      return fail(
        `"${a.subject}" is not a subject — write character:<id>, location:<id> or scene:<id>.`,
      );
    }
    const store = await AssetStore.open(ctx.workspace.paths);
    const assets = store.manifest().filter((asset) => bindsTo(asset, subject));
    if (assets.length === 0) {
      return ok(`No rendered assets for ${a.subject} yet — the pipeline draws them.`);
    }
    const rows = await Promise.all(
      assets.map(async (asset) => {
        const there = await exists(store.pathOf({ hash: asset.hash, ext: asset.ext }));
        const flags = [asset.accepted ? 'accepted' : '', there ? '' : 'bytes missing'].filter(
          Boolean,
        );
        const tail = flags.length ? `  (${flags.join(', ')})` : '';
        return `${asset.hash.slice(0, 12)}  ${assetSlotLabel(asset)}  [${asset.kind}]${tail}`;
      }),
    );
    return ok(`${assets.length} asset(s) for ${a.subject}:\n${rows.join('\n')}`, {
      data: assets.map((asset) => ({
        hash: asset.hash,
        kind: asset.kind,
        label: assetSlotLabel(asset),
        accepted: asset.accepted,
      })),
    });
  },
};

const artNotesTool: Tool<{ hash: string }> = {
  name: 'art_notes',
  description:
    'Show the art-notes rungs that reach one asset and what each says today. Art notes are the one authored field that says how a generated picture should *look*, and they go into the prompt — so a portrait answers with its character rung, a sheet with the character and the outfit, a plate with the location and the variant, and a shot frame with its own rung alone. Read-only: this is the context a proposal needs before `set_art_notes`.',
  mutating: false,
  args: z.object({ hash: z.string().min(4).describe('an asset hash or prefix from list_assets') }),
  async run(a, ctx) {
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    const { model } = await ctx.workspace.load();
    const sceneId = found.asset.satisfies[0]?.sceneId;
    const shots = await shotsFor(ctx.workspace, model, sceneId ? [sceneId] : []);
    const rungs = rungsFor(found.asset, { model, shots });
    const label = assetSlotLabel(found.asset);
    if (rungs.length === 0) {
      return ok(`${label} has no art-notes rung — nothing in the project directs how it looks.`);
    }
    const lines = rungs.map(
      (r) => `${r.target}  (${r.label})\n  ${r.notes ?? '(nothing authored)'}`,
    );
    return ok(`Art notes reaching ${label}, widest first:\n${lines.join('\n')}`, { data: rungs });
  },
};

const setArtNotesTool: Tool<{ target: string; notes?: string; mode?: NotesMode }> = {
  name: 'set_art_notes',
  description:
    'Write the art notes at one rung: character:<id>, character:<id>/<outfit>, location:<id>, location:<id>/<variant>, or shot:<sceneId>/<shotId>. Free text, appended to the prompt the project derives — so this is how a picture is changed, and it re-keys every task that rung reaches, meaning those pictures are re-drawn on the next run. `append` (the default) adds a line to what is there, `replace` overwrites it, `clear` removes it. An outfit, a variant or a shot that does not exist is refused rather than created.',
  mutating: true,
  args: z.object({
    target: z.string().min(1).describe('the rung, e.g. location:cafe/night'),
    notes: z.string().optional().describe('the text; ignored by mode="clear"'),
    mode: z.enum(['append', 'replace', 'clear']).optional().describe('default "append"'),
  }),
  async run(a, ctx) {
    // A project whose `project.yaml` will not load still has sheets to write into; neither the
    // title nor the entry reaches an art note.
    const config = await loadConfig(ctx.workspace.root).catch(() => ({ title: 'Untitled' }));
    try {
      const plan = await setArtNotes(
        { config, paths: ctx.workspace.paths },
        { target: a.target, notes: a.notes ?? '', mode: a.mode ?? 'append' },
      );
      const file = rel(ctx.workspace.root, plan.file);
      return ok(
        `${plan.note} Written to ${file}; every picture at that rung is re-drawn on the next run.`,
        { written: [file], data: { target: plan.rung.target, notes: plan.notes, file } },
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const viewImageTool: Tool<{ hash: string; question?: string }> = {
  name: 'view_image',
  description:
    'Look at one rendered picture and read a description of it back. Costs a vision call, so ask when the answer changes what you would propose — after a regeneration, or before writing an art note about a picture you have not seen. Takes a hash from `list_assets` or `list_images` and an optional question ("does this read as brutalist yet?"). An asset whose task has not run has no bytes to look at, and this says so rather than describing an older picture.',
  mutating: false,
  args: z.object({
    hash: z.string().min(4).describe('an asset hash or prefix'),
    question: z.string().optional().describe('what to ask about it; omitted asks the widest one'),
  }),
  async run(a, ctx) {
    if (!ctx.art) return fail('image tools are not available in this session; nothing was read.');
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    try {
      const res = await ctx.art.describe({
        hash: found.asset.hash,
        ...(a.question === undefined ? {} : { question: a.question }),
      });
      return ok(`${res.label} (${res.hash.slice(0, 12)}):\n${res.answer}`, { data: res });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const regenerateAssetTool: Tool<{ hash: string; run?: boolean }> = {
  name: 'regenerate_asset',
  description:
    'Draw one planned picture again: put its task back to pending, and with run=true run the pipeline so it is drawn now. Use it after `set_art_notes`, because a note only reaches a picture that is drawn again. It spends a real image generation and always asks the author first. A concept and an upload are refused by name — nothing planned them, so there is no task to re-run — and with a fixed image seed the same prompt gives back the same picture, so change a note before spending the call.',
  mutating: true,
  confirm: true,
  args: z.object({
    hash: z.string().min(4).describe('an asset hash or prefix from list_assets'),
    run: z.boolean().optional().describe('run the pipeline now; omitted only queues the task'),
  }),
  async run(a, ctx) {
    if (!ctx.pipeline) {
      return fail(
        'regenerating a planned asset runs the pipeline, which vnauthor does not do — open the project in the desktop app.',
      );
    }
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    const queued = await ctx.pipeline.regenerate(found.asset.hash);
    if (!queued.ok) return fail(queued.message);
    if (!a.run) {
      return ok(`${queued.message} Nothing is drawn until the pipeline runs.`, {
        written: queued.written,
        data: queued,
      });
    }
    const result = await ctx.pipeline.run();
    const failed = result.failed ? `, ${result.failed} failed` : '';
    const gate = result.blockedOnGate ? ' The run is held at the character-approval gate.' : '';
    return ok(`${queued.message} Ran ${result.ran} task(s)${failed}.${gate}`, {
      written: queued.written,
      data: { ...queued, ...result },
    });
  },
};

/** Escape a string for use as a literal regex (search default). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every built-in tool, in a stable order. */
export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listWorkspaceTool,
  searchTool,
  listArchiveTool,
  searchBibleTool,
  validateInputsTool,
  parseFountainTool,
  storyGraphTool,
  extractEntitiesTool,
  editCharacterTool,
  editLocationTool,
  createCharacterTool,
  createLocationTool,
  editSceneTool,
  editBranchesTool,
  setOutfitTool,
  generateImageTool,
  listImagesTool,
  editImageTool,
  listAssetsTool,
  artNotesTool,
  setArtNotesTool,
  viewImageTool,
  regenerateAssetTool,
  writeFileTool,
  editFileTool,
  updateContextTool,
  regenerateContextTool,
  discoverSkillsTool,
  runSkillTool,
  gitStatusTool,
  gitLogTool,
  gitShowTool,
  gitDiffTool,
  gitCommitTool,
  gitRevertTool,
  gitRestoreTool,
  gitInitTool,
] as Tool[];

/** Build a name→tool registry from the built-in tools (plus optional extras). */
export function createRegistry(extra: Tool[] = []): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const t of [...ALL_TOOLS, ...extra]) map.set(t.name, t);
  return map;
}
