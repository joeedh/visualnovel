import type { AssetRef, ImageParams, ImageResult } from '@vn/types';

/** An image attached to a chat/vision request. */
export interface ImageInput {
  bytes: Uint8Array;
  ext: string;
}

/** A single chat/vision turn (text + optional images) → text response. */
export interface ChatRequest {
  system?: string;
  prompt: string;
  images?: ImageInput[];
}

/** A tool advertised to a native function-calling model (JSON-Schema parameters). */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (may be a permissive object). */
  parameters: unknown;
  /**
   * Keep this definition out of the context window until the model searches for it. The full
   * definition is still sent — the API needs it server-side to run the search — so the cached
   * prefix is untouched either way. A backend without tool search ignores it.
   */
  defer?: boolean;
}

/** A tool call the model requested in a native function-calling turn. */
export interface ToolCall {
  /** Provider-assigned id, when present (Anthropic tool_use id). */
  id?: string;
  name: string;
  args: unknown;
}

/**
 * What one call cost, as the vendor reported it. Input counts everything billed as input —
 * Anthropic bills cache reads and cache writes separately, and a total that dropped them would
 * be quietly wrong on the side that matters.
 *
 * `cacheRead` and `cacheWrite` are that split, carved back out of `input` rather than added beside
 * it, so the total stays a total and a caller that wants to know whether the cache is working asks
 * for the parts. Absent means the vendor said nothing, which is not the same as zero.
 */
export interface TokenUsage {
  input: number;
  output: number;
  /** Of `input`, what was billed at the cache-read rate. */
  cacheRead?: number;
  /** Of `input`, what was billed at the cache-write rate. */
  cacheWrite?: number;
  /**
   * Set when the split above is what the provider matched rather than a line on the bill. Gemini's
   * implicit cache reports a matched prefix, bills no cache-write at all, and reports nothing for
   * the first calls of a conversation, so an absent count there does not mean a miss. Absent means
   * the figures are billing facts, as Anthropic's are.
   */
  cacheEstimated?: boolean;
}

/** A plain text turn, plus what it was billed at. */
export interface ChatReply {
  text: string;
  usage?: TokenUsage;
}

/** The reply to a native function-calling turn: free text and/or tool calls. */
export interface ChatToolReply {
  text?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

/**
 * One block of a multi-turn conversation, in provider-neutral form.
 *
 * `content` is a string for anything we compose ourselves, and the provider-native blocks a
 * previous reply handed back when it is replaying an assistant turn — thinking blocks in
 * particular can only be echoed, never rebuilt.
 */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
  /**
   * Cache the prefix ending at this turn. A backend maps it to the vendor's marker, or ignores it
   * when the vendor has none. Ignoring it never fails the request.
   */
  cache?: boolean;
}

/** What a conversation turn returned, with enough of it kept to send back. */
export interface ChatConvoReply extends ChatToolReply {
  /**
   * The assistant message's content blocks exactly as received — thinking, text, tool_use,
   * server_tool_use, tool_search_tool_result, in order. The caller echoes this verbatim;
   * rebuilding it from `text` + `toolCalls` gets a 400.
   */
  raw: unknown[];
}

/** A conversation-shaped request: one system prompt, and the turns so far. */
export interface ChatConvoRequest {
  system: string;
  turns: ChatTurn[];
}

/**
 * The low-level seam every text/vision provider sits on. Concrete backends wrap a
 * vendor SDK (Anthropic, Gemini); tests inject a fake/recorded backend so the
 * structured-output and reviewer contracts can be exercised without network access.
 *
 * `chatWithTools` is the optional native function-calling path (authoring-agent plan §M5,
 * "Path B"). Backends that implement it let the agent loop drive tools through the vendor's
 * structured tool protocol instead of the text-in/JSON-out ReAct path; the agent's
 * `AgentBackend` interface hides which one is in use.
 */
export interface ChatBackend {
  readonly modelId: string;
  message(req: ChatRequest): Promise<string>;
  chatWithTools?(req: ChatRequest, tools: ToolSchema[]): Promise<ChatToolReply>;
  /**
   * The same turn as {@link message}, plus what it cost. Optional rather than folded into
   * `message`'s return: every other caller wants the text and nothing else, and a mock or recorded
   * backend cannot say what it was billed. A caller that asks and is not answered shows no total.
   */
  messageWithUsage?(req: ChatRequest): Promise<ChatReply>;
  /**
   * A multi-turn tool-calling conversation, with cache breakpoints. Optional like
   * {@link chatWithTools}, so a mock or recorded backend can omit it. A host probes for
   * this method to pick the native agent path, because a backend carrying only `chatWithTools` is
   * single-shot and caches nothing.
   */
  chatConversation?(req: ChatConvoRequest, tools: ToolSchema[]): Promise<ChatConvoReply>;
}

/** The low-level seam for image generation/editing. */
export interface ImageBackend {
  readonly modelId: string;
  generate(prompt: string, refs: ImageInput[], params: ImageParams): Promise<ImageResult>;
  edit(
    base: ImageInput,
    prompt: string,
    refs: ImageInput[],
    params: ImageParams,
  ): Promise<ImageResult>;
}

/** Resolves an AssetRef to bytes; lets providers turn refs into image inputs. */
export type RefLoader = (ref: AssetRef) => Promise<ImageInput>;
