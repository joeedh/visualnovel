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
}

/** A tool call the model requested in a native function-calling turn. */
export interface ToolCall {
  /** Provider-assigned id, when present (Anthropic tool_use id). */
  id?: string;
  name: string;
  args: unknown;
}

/** The reply to a native function-calling turn: free text and/or tool calls. */
export interface ChatToolReply {
  text?: string;
  toolCalls: ToolCall[];
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
