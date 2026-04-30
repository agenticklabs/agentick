/**
 * Sampling — server-side outbound `sampling/createMessage` plus the
 * `ctx.sample.*` sugar surface, including the spec-defined tool-use loop.
 *
 * @module @agentick/mcp/server/sampling
 */

import type { ZodType } from "zod";
import type {
  SampleAPI,
  SamplingContentBlock,
  SamplingMessage,
  SamplingParams,
  SamplingResult,
  SamplingTextOpts,
  SamplingToolDefinition,
} from "../protocol/types.js";
import { toJSONSchemaSync } from "@agentick/kernel";

// ============================================================================
// Capability inspection
// ============================================================================

export interface SamplingCapabilities {
  /** Basic sampling support — `sampling: {}` advertised. */
  sampling: boolean;
  /** Tool-use sampling — `sampling.tools: {}` advertised. */
  tools: boolean;
  /** `includeContext` allowed — `sampling.context: {}` advertised. */
  context: boolean;
  /** Audio modality — there is no spec-defined sub-capability today; trust the host. */
  audio: boolean;
}

/**
 * Inspect a client's negotiated capabilities for sampling sub-features.
 * Returns a structured snapshot — undefined for `sampling` itself
 * means the client never opted in.
 */
export function inspectSamplingCapabilities(
  clientCapabilities: Record<string, unknown> | undefined,
): SamplingCapabilities {
  const root = (clientCapabilities ?? {}) as { sampling?: Record<string, unknown> | unknown };
  const sampling = root.sampling;
  const has = sampling != null && typeof sampling === "object";
  const sub = has ? (sampling as Record<string, unknown>) : {};
  return {
    sampling: has,
    tools: has && sub.tools != null && typeof sub.tools === "object",
    context: has && sub.context != null && typeof sub.context === "object",
    // No spec-defined sub-capability for audio yet — assume allowed when
    // sampling is enabled; the model will simply not emit audio if it
    // can't produce it. Sugar throws explicitly when no audio block is in
    // the response.
    audio: has,
  };
}

// ============================================================================
// Internal source — owned by MCPServer
// ============================================================================

export interface SamplingSource {
  /** Raw outbound primitive — issues `sampling/createMessage`. */
  request(params: SamplingParams): Promise<SamplingResult>;
  /** Capability snapshot for this session. */
  capabilities: SamplingCapabilities;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_STRUCTURED_RETRIES = 2;

/** Normalize content (single block or array) to an array. */
function asContentArray(c: SamplingContentBlock | SamplingContentBlock[]): SamplingContentBlock[] {
  return Array.isArray(c) ? c : [c];
}

/** Concatenate all text blocks into a single string. */
function extractText(content: SamplingContentBlock | SamplingContentBlock[]): string {
  const arr = asContentArray(content);
  return arr
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Find the first block of a given type. */
function findBlock<K extends SamplingContentBlock["type"]>(
  content: SamplingContentBlock | SamplingContentBlock[],
  type: K,
): Extract<SamplingContentBlock, { type: K }> | undefined {
  const arr = asContentArray(content);
  return arr.find((b) => b.type === type) as Extract<SamplingContentBlock, { type: K }> | undefined;
}

/**
 * Strip `includeContext` if the client did not advertise the
 * `sampling.context` sub-capability. The sugar layer never sends an
 * option the client didn't opt into.
 */
function scrubIncludeContext(params: SamplingParams, caps: SamplingCapabilities): SamplingParams {
  if (params.includeContext === undefined || params.includeContext === "none") return params;
  if (caps.context) return params;
  const { includeContext: _drop, ...rest } = params;
  return rest as SamplingParams;
}

/**
 * Try to extract JSON from text content — handles plain JSON, fenced
 * code blocks (` ```json ... ``` ` or ` ``` ... ``` `), and trailing/
 * leading whitespace. Returns the parsed value or throws on failure.
 */
function parseStructured(text: string): unknown {
  const trimmed = text.trim();

  // Direct JSON?
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // Fenced code block?
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  // Greedy first-{ to last-} match — last-resort
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      /* fall through */
    }
  }

  throw new Error(`Could not parse JSON from response: ${text.slice(0, 200)}`);
}

/**
 * Build a system-prompt addendum that asks the model to emit JSON
 * matching the schema. Kept short — the schema description itself
 * carries the structure.
 */
function structuredSystemPrompt(schemaJson: Record<string, unknown>, base?: string): string {
  const schemaText = JSON.stringify(schemaJson, null, 2);
  const tail =
    "Respond with ONLY a JSON object that matches the following JSON Schema. " +
    "Do not include explanations, prose, or code fences.\n\n" +
    schemaText;
  return base ? `${base}\n\n${tail}` : tail;
}

// ============================================================================
// SampleAPI implementation
// ============================================================================

export class SampleAPIImpl implements SampleAPI {
  constructor(private readonly source: SamplingSource) {}

  // ── Capability probes ──────────────────────────────────────────────────

  canUseTools(): boolean {
    return this.source.capabilities.tools;
  }
  canSampleAudio(): boolean {
    return this.source.capabilities.audio;
  }
  canIncludeContext(): boolean {
    return this.source.capabilities.context;
  }

  // ── Simple shortcuts ───────────────────────────────────────────────────

  async text(prompt: string, opts: SamplingTextOpts = {}): Promise<string> {
    const result = await this.message({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.stopSequences && { stopSequences: opts.stopSequences }),
      ...(opts.modelPreferences && { modelPreferences: opts.modelPreferences }),
      ...(opts.includeContext && { includeContext: opts.includeContext }),
    });
    return extractText(result.content);
  }

  async message(params: SamplingParams): Promise<SamplingResult> {
    const scrubbed = scrubIncludeContext(params, this.source.capabilities);
    return this.source.request(scrubbed);
  }

  async structured<T>(
    prompt: string,
    opts: { schema: ZodType<T>; maxRetries?: number } & SamplingTextOpts,
  ): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_STRUCTURED_RETRIES;
    const schemaJson = toJSONSchemaSync(opts.schema, { target: "draft-2020-12" });
    const sysPrompt = structuredSystemPrompt(schemaJson, opts.systemPrompt);

    const messages: SamplingMessage[] = [{ role: "user", content: { type: "text", text: prompt } }];

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.message({
        messages,
        systemPrompt: sysPrompt,
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.stopSequences && { stopSequences: opts.stopSequences }),
        ...(opts.modelPreferences && { modelPreferences: opts.modelPreferences }),
        ...(opts.includeContext && { includeContext: opts.includeContext }),
      });

      const text = extractText(result.content);
      try {
        const parsed = parseStructured(text);
        const validated = opts.schema.safeParse(parsed);
        if (validated.success) return validated.data;
        lastError = validated.error;
      } catch (err) {
        lastError = err;
      }

      if (attempt === maxRetries) break;

      // Append assistant turn + retry guidance for the next attempt
      messages.push({
        role: "assistant",
        content: { type: "text", text },
      });
      messages.push({
        role: "user",
        content: {
          type: "text",
          text:
            "That response could not be parsed/validated. " +
            "Reply with ONLY the JSON object matching the schema. " +
            `Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        },
      });
    }

    throw new Error(
      `structured sampling exhausted ${maxRetries + 1} attempts. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  // ── Image / Audio ──────────────────────────────────────────────────────

  async image(opts: {
    prompt: string;
    size?: "256x256" | "512x512" | "1024x1024";
    style?: string;
  }): Promise<{ data: string; mimeType: string }> {
    const promptDetails = [opts.prompt];
    if (opts.size) promptDetails.push(`Size: ${opts.size}`);
    if (opts.style) promptDetails.push(`Style: ${opts.style}`);

    const result = await this.message({
      messages: [{ role: "user", content: { type: "text", text: promptDetails.join("\n") } }],
      maxTokens: 1, // image responses don't consume text tokens; satisfy required field
      modelPreferences: { hints: [{ name: "image" }] },
    });

    const block = findBlock(result.content, "image");
    if (!block) {
      throw new Error(
        "sampling.image: response contained no image content block (host model may not support image generation)",
      );
    }
    return { data: block.data, mimeType: block.mimeType };
  }

  async audio(opts: {
    prompt: string;
    voice?: string;
  }): Promise<{ data: string; mimeType: string }> {
    const detail = opts.voice ? `${opts.prompt}\nVoice: ${opts.voice}` : opts.prompt;
    const result = await this.message({
      messages: [{ role: "user", content: { type: "text", text: detail } }],
      maxTokens: 1,
      modelPreferences: { hints: [{ name: "audio" }] },
    });

    const block = findBlock(result.content, "audio");
    if (!block) {
      throw new Error(
        "sampling.audio: response contained no audio content block (host model may not support audio generation)",
      );
    }
    return { data: block.data, mimeType: block.mimeType };
  }

  // ── Tool-use loop (spec-defined) ──────────────────────────────────────

  async withTools<T = unknown>(opts: {
    prompt: string;
    tools: Array<{
      name: string;
      description?: string;
      input: ZodType<T>;
      handler: (input: unknown) => unknown | Promise<unknown>;
    }>;
    toolChoice?: "auto" | "required" | "none";
    maxIterations?: number;
    systemPrompt?: string;
    maxTokens?: number;
    modelPreferences?: ModelPreferencesShim;
  }): Promise<{
    finalText: string;
    toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  }> {
    if (!this.source.capabilities.tools) {
      throw new Error("sampling.withTools: client did not advertise sampling.tools sub-capability");
    }

    const handlers = new Map<string, (input: unknown) => unknown | Promise<unknown>>();
    const toolDefs: SamplingToolDefinition[] = opts.tools.map((t) => {
      handlers.set(t.name, t.handler);
      return {
        name: t.name,
        ...(t.description && { description: t.description }),
        inputSchema: toJSONSchemaSync(t.input, { target: "draft-2020-12" }),
      };
    });

    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const messages: SamplingMessage[] = [
      { role: "user", content: { type: "text", text: opts.prompt } },
    ];
    const toolCalls: Array<{ name: string; input: unknown; output: unknown }> = [];

    for (let iter = 0; iter < maxIterations; iter++) {
      const result = await this.message({
        messages,
        ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
        ...(opts.modelPreferences && { modelPreferences: opts.modelPreferences }),
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        tools: toolDefs,
        ...(opts.toolChoice && { toolChoice: { mode: opts.toolChoice } }),
      });

      // Append the assistant turn so subsequent requests see the full transcript
      messages.push({ role: "assistant", content: result.content });

      const blocks = asContentArray(result.content);
      const toolUses = blocks.filter(
        (b): b is Extract<SamplingContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUses.length === 0 || result.stopReason !== "toolUse") {
        // Loop terminates — model produced final answer
        return {
          finalText: extractText(result.content),
          toolCalls,
        };
      }

      // Execute each tool_use, build matching tool_results
      const resultBlocks: SamplingContentBlock[] = [];
      for (const use of toolUses) {
        const handler = handlers.get(use.name);
        if (!handler) {
          resultBlocks.push({
            type: "tool_result",
            toolUseId: use.id,
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool '${use.name}' is not available. Available tools: ${[
                  ...handlers.keys(),
                ].join(", ")}`,
              },
            ],
          });
          continue;
        }
        try {
          const output = await handler(use.input);
          toolCalls.push({ name: use.name, input: use.input, output });
          resultBlocks.push({
            type: "tool_result",
            toolUseId: use.id,
            content: [
              {
                type: "text",
                text: typeof output === "string" ? output : JSON.stringify(output),
              },
            ],
          });
        } catch (err) {
          resultBlocks.push({
            type: "tool_result",
            toolUseId: use.id,
            isError: true,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          });
        }
      }

      // Per spec: a user message containing tool_result MUST contain ONLY
      // tool_result blocks (no mixed text/image/audio). Push exactly that.
      messages.push({ role: "user", content: resultBlocks });
    }

    throw new Error(
      `sampling.withTools: maxIterations (${maxIterations}) exhausted — model never returned a non-toolUse stopReason`,
    );
  }
}

type ModelPreferencesShim = SamplingParams["modelPreferences"];
