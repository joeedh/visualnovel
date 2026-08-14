/**
 * The tool registry (authoring-agent plan §6.3, report §7). Each tool is a thin, typed
 * shim over an already-existing function in the deterministic packages — nothing here
 * re-implements parsing, validation, or serialization. A tool declares whether it is
 * `mutating` (writes files / history) and whether it always needs explicit confirmation;
 * the loop's plan-mode gate (M3) reads those flags. Tools never decide policy themselves.
 */
import { join, relative, resolve } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { z, type ZodType } from 'zod';
import {
  applyCharacterEdit,
  applyLocationEdit,
  computeReachable,
  newCharacterDoc,
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
  mergeScene,
  moveLine,
  newScene,
  setLineText,
  setSpeaker,
  splitScene,
  type LineOp,
  type ScriptState,
} from '@vn/scriptedit';
import {
  applyMarkerPlan,
  applyScenePlan,
  planMarkerEdit,
  planSceneEdit,
  scenePlanMessage,
} from '@vn/scriptedit/write';
import { writeShots } from '@vn/store';
import { exists, readText, writeFileAtomic } from '@vn/util';
import type { Diagnostic } from '@vn/types';
import type { Git } from '@vn/git';
import { updateContext, isInside } from './context.js';
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

/** Execution context handed to every tool. */
export interface ToolContext {
  workspace: Workspace;
  git: Git;
  /**
   * Ask the host to confirm an irreversible/elevated action (e.g. running a script-bearing
   * skill). Wired by the agent loop to the permission gate; absent in bare contexts, in
   * which case elevated tools refuse rather than assume consent.
   */
  confirm?: (message: string) => Promise<boolean>;
  /** Extra directories to scan for skills, beyond the workspace's `.aiagent/skills`. */
  skillDirs?: string[];
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

/** Resolve a workspace-relative or absolute path, rejecting escapes outside the root. */
function resolveInWorkspace(root: string, p: string): string | null {
  const abs = resolve(root, p);
  return isInside(root, abs) ? abs : null;
}

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
    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    if (!(await exists(abs))) return fail(`no such file: ${a.path}`);
    const text = await readText(abs);
    if (a.offset === undefined && a.limit === undefined) return ok(text, { data: text });
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
  description: 'Search input files for a string or regex; returns file:line matches.',
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
    if (matches.length === 0) return ok(`No matches for "${a.query}".`, { data: [] });
    const body = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
    return ok(body, { data: matches });
  },
};

const searchBibleTool: Tool<{ query: string; limit?: number }> = {
  name: 'search_bible',
  description:
    'Search the story bible (wiki/) for relevant passages; returns ranked file:line excerpts.',
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
    return ok(formatExcerpts(excerpts), { data: excerpts });
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
    .record(z.string())
    .optional()
    .describe(
      'the whole wardrobe, outfit id → description; replaces the map, so send the ones being kept too',
    ),
  traits: z.array(z.string()).optional(),
  palette: z.array(z.string()).optional().describe('hex colors, e.g. #1a2a44'),
  referenceImages: z.array(z.string()).optional(),
});

const editCharacterTool: Tool<z.infer<typeof characterEditShape>> = {
  name: 'edit_character',
  description: 'Apply a validated edit to an existing character.md and write it back.',
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
  variants: z.array(z.string()).optional(),
});

const editLocationTool: Tool<z.infer<typeof locationEditShape>> = {
  name: 'edit_location',
  description: 'Apply a validated edit to an existing location.md and write it back.',
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

const createCharacterTool: Tool<{ name: string; description?: string }> = {
  name: 'create_character',
  description: 'Scaffold a new characters/<id>/character.md from a name.',
  mutating: true,
  args: z.object({ name: z.string().min(1), description: z.string().optional() }),
  async run(a, ctx) {
    const doc = newCharacterDoc(a.name, a.description ?? '');
    const id = String(doc.data['id']);
    const file = ctx.workspace.paths.characterFile(id);
    if (await exists(file)) return fail(`character ${id} already exists`);
    await writeFileAtomic(file, docToMarkdown(doc));
    return ok(`Created character ${id}.`, {
      written: [rel(ctx.workspace.root, file)],
      data: { id },
    });
  },
};

const createLocationTool: Tool<{ name: string; description?: string }> = {
  name: 'create_location',
  description: 'Scaffold a new locations/<id>.md from a name.',
  mutating: true,
  args: z.object({ name: z.string().min(1), description: z.string().optional() }),
  async run(a, ctx) {
    const doc = newLocationDoc(a.name, a.description ?? '');
    const id = String(doc.data['id']);
    const file = ctx.workspace.paths.locationFile(id);
    if (await exists(file)) return fail(`location ${id} already exists`);
    await writeFileAtomic(file, docToMarkdown(doc));
    return ok(`Created location ${id}.`, {
      written: [rel(ctx.workspace.root, file)],
      data: { id },
    });
  },
};

// ── Scene prose (execute mode) ──────────────────────────────────────────────

/**
 * The ten acts, named exactly as the desktop's `story.*` commands are, because they *are* those
 * commands' decisions: an agent transcript and a command history should read as the same vocabulary.
 */
const SCENE_OPS = [
  'setLineText',
  'insertLine',
  'deleteLine',
  'moveLine',
  'moveShot',
  'setSpeaker',
  'newScene',
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
    .describe('insertLine, moveShot, newScene, deleteScene, splitScene, mergeScene'),
  line: z.string().optional().describe('a line id like arrival:L3 — the four line edits'),
  shot: z.string().optional().describe('moveShot: the shot id to move, e.g. arrival__beat1'),
  text: z.string().optional().describe('setLineText, insertLine'),
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
  heading: z.string().optional().describe('newScene: e.g. INT. CLASSROOM - EVENING'),
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
  deleteLine: ['line'],
  moveLine: ['line'],
  moveShot: ['scene', 'shot'],
  setSpeaker: ['line'],
  newScene: ['scene', 'heading'],
  deleteScene: ['scene'],
  splitScene: ['scene', 'at', 'into'],
  mergeScene: ['scene', 'into'],
};

/**
 * The one `@vn/scriptedit` decision an op names, with the tool's defaults filled in. Async only
 * because `moveShot`'s rule needs the scene's storyboard, which is read off disk; the other nine
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
    'storyboard; moveShot costs it nothing, since no coverage and no covered prose changes.',
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

/** A path a validated tool owns, which `write_file` therefore must not overwrite blind. */
function guardedBy(path: string): string | null {
  const first = path.replace(/\\/g, '/').split('/')[0];
  return first === 'scenes' ? 'edit_scene' : null;
}

const writeFileTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a workspace file. Execute mode only, and never a scene: scenes/ belongs ' +
    'to edit_scene.',
  mutating: true,
  args: z.object({ path: z.string(), content: z.string() }),
  async run(a, ctx) {
    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    // A chunk written whole is unvalidated: duplicate line ids, a lost heading, a scene id that
    // no longer matches the filename. `edit_scene` proves each of those before it writes.
    const owner = guardedBy(rel(ctx.workspace.root, abs));
    if (owner) return fail(`${a.path} is written by ${owner}, not write_file`);
    await writeFileAtomic(abs, a.content);
    return ok(`Wrote ${a.path}.`, { written: [rel(ctx.workspace.root, abs)] });
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
  description: 'Persist a durable instruction into AICONTEXT.md.',
  mutating: true,
  args: z.object({ rule: z.string().min(1) }),
  async run(a, ctx) {
    const file = await updateContext(ctx.workspace.root, a.rule);
    return ok(`Recorded rule in AICONTEXT.md.`, { written: [rel(ctx.workspace.root, file)] });
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
  description: 'Stage and commit the approved change set with a message.',
  mutating: true,
  args: z.object({ message: z.string().min(1), paths: z.array(z.string()).optional() }),
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

/** Escape a string for use as a literal regex (search default). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every built-in tool, in a stable order. */
export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listWorkspaceTool,
  searchTool,
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
  setOutfitTool,
  writeFileTool,
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
