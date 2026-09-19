/**
 * The tool registry's shared types and helpers (authoring-agent plan §6.3, report §7). Each tool
 * is a thin, typed shim over an already-existing function in the deterministic packages — nothing
 * here re-implements parsing, validation, or serialization. A tool declares whether it is
 * `mutating` (writes files / history) and whether it always needs explicit confirmation; the
 * loop's plan-mode gate (M3) reads those flags. Tools never decide policy themselves.
 */
import { relative } from 'node:path';
import { z, type ZodType } from 'zod';
import type { Diagnostic, TextLLM } from '@vn/types';
import type { Git } from '@vn/git';
import type { ApprovalControl } from '../approve.js';
import type { ArtGen } from '../art.js';
import type { Workspace } from '../workspace.js';

/** A text observation for the loop, plus optional structured data. */
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
 * Re-rendering a planned picture, as an injected capability. Deliberately not the scheduler: it
 * offers two acts, queue and run, which is all an agent needs to ask for.
 */
export interface PipelineControl {
  /** Put an asset's task back to `pending`. Refuses a concept, an upload, and an orphaned task. */
  regenerate(hash: string): Promise<{ ok: boolean; message: string; written: string[] }>;
  /** Run the pipeline to completion, as `vngen run` would. */
  run(): Promise<{ ran: number; failed: number; blockedOnGate: boolean }>;
}

/**
 * Running a generation graph, as an injected capability. A run spends real image generations
 * through the executor and the journal, which `@vn/authoring` has no host for, so whichever
 * host owns those supplies this. Reading and editing a graph need neither and go straight to
 * the files under `vngen/work/graphs/`.
 */
export interface GraphControl {
  /** What one run is expected to spend, in the sentence the desktop confirmation quotes. */
  estimate(slug: string): Promise<{ ok: false; reason: string } | { ok: true; note: string }>;
  /** Execute the graph to its active output, resuming from the journal unless `force`. */
  run(
    slug: string,
    opts: { force: boolean },
  ): Promise<{ ok: boolean; message: string; written: string[] }>;
}

/**
 * What the agent was last shown of each workspace file, keyed by workspace-relative path. Each
 * entry holds the hash it read at and whether it saw all of it. This records the conversation
 * rather than the disk: nothing watches the filesystem, and a write compares a fresh read
 * against what is written here.
 */
export type ReadLedger = Map<string, { hash: string; whole: boolean }>;

/** Execution context handed to every tool. */
export interface ToolContext {
  workspace: Workspace;
  git: Git;
  /**
   * The read ledger, owned by the agent loop and cleared with the conversation. Absent in bare
   * contexts, where `edit_file` refuses rather than edit a file the conversation never read.
   */
  seen?: ReadLedger;
  /**
   * Ask the host to confirm an irreversible/elevated action (e.g. running a script-bearing
   * skill). Wired by the agent loop to the permission gate; absent in bare contexts, in
   * which case elevated tools refuse rather than assume consent.
   */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Where the builtin skill catalog is on disk, supplied by the host that knows its own layout
   * (`BUILTIN_SKILLS_PATH`). Absent in bare contexts, where discovery lists the project's and
   * the user's skills only.
   */
  builtinSkillsDir?: string;
  /**
   * Image generation, wired by the host that knows whether this run is mocked and where the keys
   * are. Absent in bare contexts, in which case `generate_image` and `edit_image` refuse rather
   * than assume an API key exists to spend.
   */
  art?: ArtGen;
  /**
   * The structured-text model, wired by the host that knows the model id, where the keys are and
   * whether this run is mocked — the text-side counterpart of `art`. Absent in bare contexts,
   * where `propose_storyboard` refuses rather than assume an API key exists to spend.
   */
  text?: TextLLM;
  /**
   * Re-rendering a planned asset, wired by the host that owns the pipeline. `@vn/authoring` may
   * not import `@vn/pipeline` or `@vn/scheduler`, so the host supplies this instead. When it is
   * absent, as in the REPL, `regenerate_asset` refuses and names the host that can.
   */
  pipeline?: PipelineControl;
  /**
   * Approving generated art, wired by the host that owns the manifest. When it is absent, as in
   * the REPL, `approve_assets` refuses and names the host that can.
   */
  approval?: ApprovalControl;
  /**
   * Running a generation graph, wired by the host that owns the executor and the image backend.
   * Absent in bare contexts, where `run_asset_graph` refuses and names the host that can. Reading
   * and editing a graph do not go through it, so both work wherever the project is opened.
   */
  graphs?: GraphControl;
  /**
   * The author's own turns this conversation, oldest first, supplied by the agent loop. It reads
   * the transcript rather than the disk on purpose: consent is judged from what the author said
   * to this agent. Absent in bare contexts, where `approve_assets` refuses because its authority
   * comes from the author's words.
   */
  said?: () => readonly string[];
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

export const ok = (output: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  output,
  ...extra,
});
export const fail = (output: string): ToolResult => ({ ok: false, output });

export const rel = (root: string, abs: string): string => relative(root, abs).replace(/\\/g, '/');

export function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return 'No diagnostics. Inputs are valid.';
  return diags
    .map((d) => `[${d.severity}] ${d.code}${d.where ? ` (${d.where})` : ''}: ${d.message}`)
    .join('\n');
}

/**
 * How far a signature descends into nested shapes before falling back to `object` / `any`. Two
 * covers every nested shape in the registry — `write_storyboard`'s `shots[].subjects[]` is the
 * deepest — and bounds what a future tool can add to the cached prefix.
 */
const SIGNATURE_DEPTH = 2;

/**
 * Render a zod base type as a short name for a tool-arg signature. A nested object below
 * {@link SIGNATURE_DEPTH} is spelled out; past it a shape collapses to `object` or `any`, which is
 * what left `write_storyboard`'s real argument names unreachable and had the model guessing them.
 */
function zodTypeName(t: ZodType, depth = 0): string {
  if (t instanceof z.ZodOptional || t instanceof z.ZodDefault || t instanceof z.ZodNullable)
    return zodTypeName(t._def.innerType as ZodType, depth);
  if (t instanceof z.ZodArray) return `${zodTypeName(t._def.type as ZodType, depth)}[]`;
  if (t instanceof z.ZodEnum) return (t._def.values as string[]).map((v) => `"${v}"`).join('|');
  if (t instanceof z.ZodString) return 'string';
  if (t instanceof z.ZodNumber) return 'number';
  if (t instanceof z.ZodBoolean) return 'boolean';
  if (depth >= SIGNATURE_DEPTH) return t instanceof z.ZodObject ? 'object' : 'any';
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, ZodType>;
    const fields = Object.entries(shape).map(
      ([name, f]) => `${name}${isOptional(f) ? '?' : ''}: ${zodTypeName(f, depth + 1)}`,
    );
    return `{ ${fields.join(', ')} }`;
  }
  if (t instanceof z.ZodRecord)
    return `record<string, ${zodTypeName(t._def.valueType as ZodType, depth + 1)}>`;
  if (t instanceof z.ZodUnion)
    return (t._def.options as ZodType[]).map((o) => zodTypeName(o, depth + 1)).join(' | ');
  return 'any';
}

const isOptional = (t: ZodType): boolean => t instanceof z.ZodOptional || t instanceof z.ZodDefault;

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
      const note = field.description ? ` (${field.description})` : '';
      return `${name}${isOptional(field) ? '?' : ''}: ${zodTypeName(field)}${note}`;
    })
    .join(', ');
}

/**
 * One zod type as JSON Schema, covering the subset the registry uses. Mirrors {@link zodTypeName}'s
 * switch and sits beside it so the two stay in step. zod is pinned at ^3, which has no
 * `z.toJSONSchema`, and one call site does not earn a dependency.
 *
 * `_def.unknownKeys` is ignored, so a `.strict()` shape never becomes
 * `additionalProperties: false`. A vendor-side rejection arrives as a request error rather than as
 * an observation the model can act on, so unknown keys are refused by zod in the loop instead.
 * Properties are emitted in the zod shape's own order and never sorted: the tool catalog sits in
 * the cached prefix and must be byte-stable across turns.
 */
function jsonTypeOf(t: ZodType): Record<string, unknown> {
  const note = t.description ? { description: t.description } : {};
  if (t instanceof z.ZodOptional || t instanceof z.ZodDefault)
    return { ...jsonTypeOf(t._def.innerType as ZodType), ...note };
  if (t instanceof z.ZodNullable)
    return { anyOf: [jsonTypeOf(t._def.innerType as ZodType), { type: 'null' }], ...note };
  if (t instanceof z.ZodArray)
    return { type: 'array', items: jsonTypeOf(t._def.type as ZodType), ...note };
  if (t instanceof z.ZodEnum) return { type: 'string', enum: t._def.values as string[], ...note };
  if (t instanceof z.ZodString) return { type: 'string', ...note };
  if (t instanceof z.ZodNumber) return { type: 'number', ...note };
  if (t instanceof z.ZodBoolean) return { type: 'boolean', ...note };
  if (t instanceof z.ZodRecord)
    return {
      type                : 'object',
      additionalProperties: jsonTypeOf(t._def.valueType as ZodType),
      ...note,
    };
  if (t instanceof z.ZodUnion)
    return { anyOf: (t._def.options as ZodType[]).map(jsonTypeOf), ...note };
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, field] of Object.entries(shape)) {
      properties[name] = jsonTypeOf(field);
      if (!isOptional(field)) required.push(name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), ...note };
  }
  return { ...note };
}

/** A tool's arguments as JSON Schema, or undefined when the tool's args are not an object shape. */
export function jsonSchemaOf(schema: ZodType): Record<string, unknown> | undefined {
  return schema instanceof z.ZodObject ? jsonTypeOf(schema) : undefined;
}
