/**
 * `GoogleExecutor` — `LanguageModelExecutor` backed by the Gemini API
 * (`@google/genai` SDK). Supports the Gemini Developer API (apiKey
 * path) and Vertex AI (project/location/auth path).
 *
 * Gemini-specific knobs handled at this layer:
 * - `sanitizeSchemaForGemini` — strict JSON-Schema subset for tool input
 * - `thoughtSignature` round-trip (Gemini 3+ thinking; opaque signature
 *   that MUST be sent back on subsequent turns to avoid
 *   MISSING_THOUGHT_SIGNATURE)
 * - `part.thought` flag routes text parts to the reasoning channel
 *   (Gemini 2.5+ thinking models)
 * - `thoughtsTokenCount` + `cachedContentTokenCount` usage surfacing
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import {
  GoogleGenAI,
  FinishReason,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type Part,
  type Tool as GoogleTool,
  type FunctionDeclaration,
} from "@google/genai";

import { ulid } from "@agentick/runtime-next";
import { BaseLanguageModelExecutor, type StreamContext } from "@agentick/executor-next";
import type { EventBus, MessageInbox, OperationJournal } from "@agentick/spec-next";
import type {
  ContentBlock,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelStopReason,
  LanguageModelTool,
  NormalizeInput,
  ToolCall,
  UsageStats,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";

import {
  StreamTagParser,
  type StreamTagEvent,
  type StreamTagHandler,
} from "@agentick/executor-openai-next";

// ============================================================================
// ProviderOptions augmentation — typed Google escape hatch (G5)
// ============================================================================

/**
 * All three v2 provider-option tiers contributed at once via the
 * SDK's actual types — no hand-rolled subsets.
 *
 * - `ProviderClientOptions["google"]`: {@link GoogleGenAIOptions} —
 *   every field the SDK constructor accepts (apiKey, vertexai,
 *   project, location, googleAuthOptions, httpOptions…).
 *
 * - `ProviderOptions["google"]`: {@link GenerateContentConfig} —
 *   every field the SDK accepts on per-call `config` (temperature,
 *   topP, topK, seed, safetySettings, thinkingConfig, cachedContent,
 *   responseLogprobs, …). Spread last onto the request config so
 *   any canonical knob the executor sets from
 *   `LanguageModelParameters` can be overridden by the adopter.
 *   Fields the executor controls structurally and SHOULD NOT be set
 *   via providerOptions: `systemInstruction`, `tools`, `abortSignal`,
 *   `httpOptions`.
 *
 * - `ProviderToolOptions["google"]`: `Partial<FunctionDeclaration>` —
 *   per-tool overrides merged onto the projected function
 *   declaration (e.g. `behavior`, custom `parameters`, etc.).
 */
declare module "@agentick/spec-next" {
  interface ProviderClientOptions {
    readonly google?: GoogleGenAIOptions;
  }
  interface ProviderOptions {
    readonly google?: GenerateContentConfig;
  }
  interface ProviderToolOptions {
    readonly google?: Partial<FunctionDeclaration>;
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface GoogleExecutorOptions {
  /** Default model id. Overridable per call via `target.modelId`. */
  readonly model?: string;
  /**
   * SDK client construction options — every field
   * `@google/genai`'s `GoogleGenAI` constructor accepts (apiKey,
   * vertexai, project, location, googleAuthOptions, httpOptions, …).
   * Typed via the augmentable
   * {@link import("@agentick/spec-next").ProviderClientOptions} slot —
   * adopters get full IntelliSense from the SDK directly. Ignored
   * when `client` is supplied.
   *
   * Env-var fallbacks (`GOOGLE_API_KEY`, `GEMINI_API_KEY`,
   * `GOOGLE_GENAI_BASE_URL`) are applied during construction when the
   * corresponding field is absent.
   */
  readonly clientOptions?: GoogleGenAIOptions;
  /** Inject a pre-built `GoogleGenAI` client (testing, advanced setups). */
  readonly client?: GoogleGenAI;
  /** Whether `run()` streams by default. Per-call wins via the target. */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags in text. For Gemini 2.5+
   * thinking models, native `part.thought === true` is preferred —
   * this is for the niche case of piping a non-thinking Gemini
   * through a pre-prompt eliciting `<think>` artifacts.
   */
  readonly parseThinkTags?: boolean;
  /** Adopter-declared XML-like tags to extract (G12). */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  /** Override the self-described target. */
  readonly target?: ExecutionTarget;
}

export interface CustomBlockDefinition {
  readonly tag?: string;
  readonly onStart?: (attrs: Readonly<Record<string, string>>) => void;
  readonly onContent?: (content: string, attrs: Readonly<Record<string, string>>) => void;
  readonly onSelfClosing?: (attrs: Readonly<Record<string, string>>) => void;
}

// ============================================================================
// Internals
// ============================================================================

const SPEC_VERSION_LITERAL = SPEC_VERSION;
const DEFAULT_MODEL = "gemini-2.5-flash";

// ============================================================================
// GoogleExecutor
// ============================================================================

export class GoogleExecutor extends BaseLanguageModelExecutor<GenerateContentResponse> {
  readonly target: ExecutionTarget;

  protected override readonly streamByDefault: boolean;

  private readonly client: GoogleGenAI;
  private readonly defaultModel: string | undefined;
  private readonly parseThinkTags: boolean;
  private readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: GoogleExecutorOptions = {},
  ) {
    super(scopeId, journal, bus, inbox);
    this.client = options.client ?? new GoogleGenAI(buildClientOptions(options));
    this.defaultModel = options.model;
    this.streamByDefault = options.stream ?? false;
    this.parseThinkTags = options.parseThinkTags ?? false;
    this.customBlocks = options.customBlocks;
    this.target = options.target ?? {
      kind: "language-model",
      provider: "google",
      modelId: options.model ?? DEFAULT_MODEL,
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 8_192,
      },
    };
  }

  // ──────── Hooks (BaseLanguageModelExecutor) ────────

  protected buildParams(
    input: LanguageModelInput,
    target: ExecutionTarget,
  ): GenerateContentParameters {
    return toGoogleParams(input, target, this.defaultModel);
  }

  protected callProvider(
    params: unknown,
    _signal: AbortSignal | undefined,
  ): Promise<GenerateContentResponse> {
    // Google SDK doesn't accept abort signal on the call directly;
    // aborts surface as the stream iterator throwing. We rely on the
    // base's in-flight tracking + the user-supplied AbortController.
    return this.client.models.generateContent(params as GenerateContentParameters);
  }

  protected async drainStream(
    params: unknown,
    ctx: StreamContext,
  ): Promise<GenerateContentResponse> {
    const cp = params as GenerateContentParameters;
    const stream = (await this.client.models.generateContentStream(
      cp,
      // SDK doesn't accept abort signal on the call directly; aborts
      // surface as the stream iterator throwing when ctx.signal fires.
    )) as unknown as AsyncIterable<GenerateContentResponse>;

    const tagRouter = buildTagRouter({
      parseThinkTags: this.parseThinkTags,
      customBlocks: this.customBlocks,
    });

    // Single-pass aggregation: build the final response shape as we
    // stream. No second walk in normalize() — see G18 perf notes.
    const accum = new GoogleStreamAccumulator();

    // Active-block tracking. Gemini doesn't give us indices, so we
    // maintain a logical index that bumps when the block type changes.
    let blockIndex = -1;
    let activeKind: "text" | "reasoning" | null = null;
    let routerReasoningStarted = false;
    let routerReasoningAccum = "";

    const closeActive = (): void => {
      if (activeKind === "text") {
        ctx.emit({ type: "content-end", blockIndex });
        const text = accum.currentTextBuffer();
        ctx.emit({
          type: "content",
          blockIndex,
          content: { type: "text", text } as ContentBlock,
        });
      } else if (activeKind === "reasoning") {
        ctx.emit({ type: "reasoning-end", blockIndex });
        ctx.emit({
          type: "reasoning",
          blockIndex,
          reasoning: accum.currentReasoningBuffer(),
        });
      }
      activeKind = null;
    };

    const handleTagEvent = (event: StreamTagEvent): void => {
      if (event.type === "text") {
        if (event.content.length === 0) return;
        if (activeKind !== "text") {
          closeActive();
          blockIndex += 1;
          accum.startTextBlock();
          ctx.emit({ type: "content-start", blockIndex, blockType: "text" });
          activeKind = "text";
        }
        ctx.emit({ type: "content-delta", blockIndex, delta: event.content });
        accum.appendText(event.content);
        return;
      }
      const mode = tagRouter!.modeFor(event.tag);
      if (mode === "reasoning") {
        switch (event.type) {
          case "block-start":
            if (!routerReasoningStarted) {
              if (activeKind !== null) closeActive();
              blockIndex += 1;
              accum.startReasoningBlock();
              ctx.emit({ type: "reasoning-start", blockIndex });
              routerReasoningStarted = true;
              activeKind = "reasoning";
            }
            break;
          case "block-delta":
            if (!routerReasoningStarted) {
              if (activeKind !== null) closeActive();
              blockIndex += 1;
              accum.startReasoningBlock();
              ctx.emit({ type: "reasoning-start", blockIndex });
              routerReasoningStarted = true;
              activeKind = "reasoning";
            }
            ctx.emit({ type: "reasoning-delta", blockIndex, delta: event.delta });
            accum.appendReasoning(event.delta);
            routerReasoningAccum += event.delta;
            break;
          case "block-end":
          case "block":
            // Close handled at next non-tag content or end of stream.
            break;
        }
        return;
      }
      switch (event.type) {
        case "block-start":
          ctx.emit({ type: "custom-block-start", tag: event.tag, attrs: event.attrs });
          break;
        case "block-delta":
          ctx.emit({ type: "custom-block-delta", tag: event.tag, delta: event.delta });
          break;
        case "block-end":
          ctx.emit({ type: "custom-block-end", tag: event.tag });
          break;
        case "block":
          ctx.emit({
            type: "custom-block",
            tag: event.tag,
            content: event.content,
            attrs: event.attrs,
            ...(event.selfClosing ? { selfClosing: true } : {}),
          });
          break;
      }
    };

    let modelSeen: string | undefined;
    let stopReason: LanguageModelStopReason = "end";
    let finalUsage: UsageStats | undefined;

    for await (const chunk of stream) {
      if (chunk.modelVersion && !modelSeen) modelSeen = chunk.modelVersion;
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      const parts = candidate.content?.parts ?? [];

      for (const part of parts) {
        const isThought = (part as { thought?: boolean }).thought === true;

        // Text path
        if (typeof part.text === "string" && part.text.length > 0) {
          if (isThought) {
            // Native Gemini 2.5+ thinking — route to reasoning channel.
            if (activeKind !== "reasoning") {
              closeActive();
              blockIndex += 1;
              accum.startReasoningBlock();
              ctx.emit({ type: "reasoning-start", blockIndex });
              activeKind = "reasoning";
            }
            ctx.emit({ type: "reasoning-delta", blockIndex, delta: part.text });
            accum.appendReasoning(part.text);
            continue;
          }
          if (tagRouter) {
            for (const ev of tagRouter.parser.process(part.text)) {
              handleTagEvent(ev);
            }
          } else {
            if (activeKind !== "text") {
              closeActive();
              blockIndex += 1;
              accum.startTextBlock();
              ctx.emit({ type: "content-start", blockIndex, blockType: "text" });
              activeKind = "text";
            }
            ctx.emit({ type: "content-delta", blockIndex, delta: part.text });
            accum.appendText(part.text);
          }
          continue;
        }

        // Function call path
        if (part.functionCall) {
          closeActive();
          const fc = part.functionCall;
          const callId = fc.id ?? `call_${ulid()}`;
          const name = fc.name ?? "";
          const args = (fc.args ?? {}) as Record<string, unknown>;
          const signature = (part as { thoughtSignature?: string }).thoughtSignature;
          blockIndex += 1;
          accum.recordToolCall({
            callId,
            name,
            input: args,
            ...(signature !== undefined ? { thoughtSignature: signature } : {}),
          });
          ctx.emit({
            type: "tool-call-start",
            callId,
            name,
            blockIndex,
          });
          const jsonDelta = JSON.stringify(args);
          if (jsonDelta !== "{}") {
            ctx.emit({ type: "tool-call-delta", callId, delta: jsonDelta });
          }
          ctx.emit({ type: "tool-call-end", callId });
          ctx.emit({
            type: "tool-call",
            callId,
            name,
            input: args,
            ...(signature !== undefined
              ? {
                  providerMetadata: {
                    google: { thoughtSignature: signature },
                  },
                }
              : {}),
          });
        }
      }

      if (candidate.finishReason) {
        stopReason = mapFinishReason(candidate.finishReason);
        finalUsage = toUsageStats(chunk.usageMetadata);
        accum.setFinishReason(candidate.finishReason);
        accum.setUsage(chunk.usageMetadata);
      }
    }

    // Drain tag router's remaining buffer.
    if (tagRouter) {
      for (const ev of tagRouter.parser.flush()) {
        handleTagEvent(ev);
      }
    }
    closeActive();
    void routerReasoningAccum; // local-only for parity with OpenAI path

    if (!finalUsage) finalUsage = toUsageStats(undefined);

    ctx.emit({ type: "message-end", stopReason, usage: finalUsage });
    ctx.emit({
      type: "message",
      message: {
        role: "assistant",
        content: accum.toContentBlocks(),
        model: modelSeen ?? cp.model,
      },
      stopReason,
      usage: finalUsage,
    });

    return accum.toResponse(modelSeen ?? cp.model);
  }

  protected normalizeRaw(raw: GenerateContentResponse): LanguageModelExecutionResult {
    return normalizeImpl({ targetOutput: raw, target: this.target });
  }

  protected override postProcessForNormalize(
    raw: GenerateContentResponse,
  ): GenerateContentResponse {
    const router = buildTagRouter({
      parseThinkTags: this.parseThinkTags,
      customBlocks: this.customBlocks,
    });
    return router ? (applyTagRouterToResponse(raw, router) as GenerateContentResponse) : raw;
  }
}

// ============================================================================
// Client construction
// ============================================================================

function buildClientOptions(opts: GoogleExecutorOptions): GoogleGenAIOptions {
  // Adopter-supplied clientOptions wins; env-var fallbacks fill in any
  // missing fields. Spread last so explicit clientOptions overrides
  // env-derived values.
  const base: GoogleGenAIOptions = {};
  const envApiKey = process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"];
  if (envApiKey !== undefined) base.apiKey = envApiKey;
  const envBaseUrl = process.env["GOOGLE_GENAI_BASE_URL"];
  if (envBaseUrl !== undefined) {
    base.httpOptions = { baseUrl: envBaseUrl };
  }
  if (opts.clientOptions !== undefined) {
    // Merge httpOptions deeply so env baseUrl + adopter timeout/headers
    // both land.
    const merged: GoogleGenAIOptions = { ...base, ...opts.clientOptions };
    if (base.httpOptions !== undefined && opts.clientOptions.httpOptions !== undefined) {
      merged.httpOptions = { ...base.httpOptions, ...opts.clientOptions.httpOptions };
    }
    return merged;
  }
  return base;
}

// ============================================================================
// Tag routing — shared StreamTagParser machinery (G7 + G12)
// ============================================================================

type TagMode = "reasoning" | "custom-block";

interface TagRouter {
  readonly parser: StreamTagParser;
  modeFor(tag: string): TagMode;
}

function buildTagRouter(opts: {
  parseThinkTags: boolean;
  customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
}): TagRouter | null {
  const tagModes = new Map<string, TagMode>();
  const handlers: Record<string, StreamTagHandler> = {};

  if (opts.parseThinkTags) {
    tagModes.set("think", "reasoning");
    handlers["think"] = {};
  }
  if (opts.customBlocks) {
    for (const [key, def] of Object.entries(opts.customBlocks)) {
      const tagName = def.tag ?? key;
      tagModes.set(tagName, "custom-block");
      const h: StreamTagHandler = {};
      if (def.onStart) h.onStart = def.onStart;
      if (def.onContent) h.onContent = def.onContent;
      if (def.onSelfClosing) h.onSelfClosing = def.onSelfClosing;
      handlers[tagName] = h;
    }
  }
  if (tagModes.size === 0) return null;
  const parser = new StreamTagParser({ tags: handlers });
  return {
    parser,
    modeFor(tag) {
      return tagModes.get(tag) ?? "custom-block";
    },
  };
}

/**
 * Post-process a non-streaming GenerateContentResponse through the tag
 * router. Each text part is replaced with its cleaned version; reasoning
 * extracted from `<think>` tags is prepended as a synthetic
 * `thought`-flagged text part.
 */
function applyTagRouterToResponse(raw: unknown, router: TagRouter): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as GenerateContentResponse;
  const candidate = r.candidates?.[0];
  if (!candidate?.content?.parts) return raw;
  const newParts: Part[] = [];
  let reasoning = "";
  for (const part of candidate.content.parts) {
    if (typeof part.text === "string" && !(part as { thought?: boolean }).thought) {
      let cleaned = "";
      const events = [...router.parser.process(part.text), ...router.parser.flush()];
      for (const ev of events) {
        if (ev.type === "text") cleaned += ev.content;
        else if (ev.type === "block-delta") {
          if (router.modeFor(ev.tag) === "reasoning") reasoning += ev.delta;
        }
      }
      if (cleaned.length > 0) newParts.push({ text: cleaned });
    } else {
      newParts.push(part);
    }
  }
  if (reasoning.length > 0) {
    newParts.unshift({ text: reasoning, thought: true } as Part);
  }
  (candidate.content as { parts: Part[] }).parts = newParts;
  return raw;
}

// ============================================================================
// IR → Google params
// ============================================================================

function toGoogleParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
): GenerateContentParameters {
  const { systemInstruction, contents } = toGoogleContents(input.messages);
  const tools = input.tools && input.tools.length > 0 ? toGoogleTools(input.tools) : undefined;

  const config: Record<string, unknown> = {};
  const p = input.parameters;
  if (p?.temperature !== undefined) config.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) config.maxOutputTokens = p.maxOutputTokens;
  if (p?.topP !== undefined) config.topP = p.topP;
  if (p?.stopSequences !== undefined) config.stopSequences = [...p.stopSequences];
  if (p?.responseFormat !== undefined) {
    if (p.responseFormat.type === "json" || p.responseFormat.type === "json_schema") {
      config.responseMimeType = "application/json";
    }
    if (p.responseFormat.type === "json_schema" && p.responseFormat.schema) {
      config.responseSchema = p.responseFormat.schema;
    }
  }
  // Silently drop frequencyPenalty / presencePenalty — Gemini has no native support.

  if (systemInstruction !== undefined) config.systemInstruction = systemInstruction;
  if (tools !== undefined) config.tools = tools;

  // G5 — adopter escape hatch. Spread last onto config.
  const overrides = target.providerOptions?.google;
  if (overrides && typeof overrides === "object") {
    Object.assign(config, overrides);
  }

  const params: GenerateContentParameters = {
    model: target.modelId ?? defaultModel ?? DEFAULT_MODEL,
    contents,
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
  return params;
}

function toGoogleContents(messages: ReadonlyArray<LanguageModelMessage>): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const out: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n\n");
      if (text) systemParts.push(text);
      continue;
    }

    const role: "user" | "model" = message.role === "assistant" ? "model" : "user";
    const parts: Part[] = [];

    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text.length > 0) parts.push({ text: part.text });
          break;
        case "image": {
          const partOut = imagePartFromUrl(part.imageUrl, part.mediaType);
          if (partOut) parts.push(partOut);
          break;
        }
        case "tool_use": {
          const signature = part.providerMetadata?.["google"]?.["thoughtSignature"];
          const functionCallPart: Part = {
            functionCall: {
              id: part.id,
              name: part.name,
              args: (part.input ?? {}) as Record<string, unknown>,
            },
          };
          if (typeof signature === "string") {
            (functionCallPart as { thoughtSignature?: string }).thoughtSignature = signature;
          }
          parts.push(functionCallPart);
          break;
        }
        case "tool_result": {
          const responseText = toolResultText(part.content);
          parts.push({
            functionResponse: {
              id: part.toolUseId,
              name: lookupToolName(out, part.toolUseId) ?? part.toolUseId,
              response: { result: responseText },
            },
          });
          break;
        }
      }
    }
    if (parts.length === 0) continue;

    // Coalesce same-role consecutive entries (Google supports both
    // alternation and same-role coalescing, but coalescing is cleaner).
    const last = out[out.length - 1];
    if (last && last.role === role) {
      (last.parts as Part[]).push(...parts);
    } else {
      out.push({ role, parts });
    }
  }

  const systemInstruction =
    systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined;

  return { systemInstruction, contents: out };
}

function toolResultText(parts: ReadonlyArray<LanguageModelMessagePart>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push(part.text);
    else out.push(JSON.stringify(part));
  }
  return out.join("\n") || "Done";
}

/**
 * Look up the function name associated with a previously-emitted
 * functionCall in the contents-so-far. Gemini requires the
 * functionResponse's `name` to match the original call's name (not the
 * id). Returns undefined if not found.
 */
function lookupToolName(contents: ReadonlyArray<Content>, toolUseId: string): string | undefined {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (!c || !Array.isArray(c.parts)) continue;
    for (const p of c.parts) {
      if (p.functionCall && p.functionCall.id === toolUseId) {
        return p.functionCall.name;
      }
    }
  }
  return undefined;
}

function imagePartFromUrl(imageUrl: string, mimeType: string | undefined): Part | null {
  if (imageUrl.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
    if (match) {
      return {
        inlineData: {
          mimeType: match[1] ?? mimeType ?? "image/jpeg",
          data: match[2] ?? "",
        },
      };
    }
  }
  return {
    fileData: {
      mimeType: mimeType ?? "image/jpeg",
      fileUri: imageUrl,
    },
  };
}

function toGoogleTools(tools: ReadonlyArray<LanguageModelTool>): GoogleTool[] {
  const functionDeclarations: FunctionDeclaration[] = tools.map((t) => {
    const base: FunctionDeclaration = {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: ensureObjectSchema(
        sanitizeSchemaForGemini(t.inputSchema as Record<string, unknown>),
      ) as FunctionDeclaration["parameters"],
    };
    // Per-tool providerOptions.google — adopter-supplied overrides
    // win over executor-projected defaults.
    const overrides = t.providerOptions?.google;
    return overrides ? { ...base, ...overrides } : base;
  });
  return [{ functionDeclarations }];
}

// ============================================================================
// GenerateContentResponse → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isGoogleResponse(raw)) {
    throw new Error("normalize expected Google GenerateContentResponse shape");
  }
  const candidate = raw.candidates?.[0];
  const output: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      const isThought = (part as { thought?: boolean }).thought === true;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (isThought) {
          output.push({ type: "reasoning", text: part.text });
        } else {
          output.push({ type: "text", text: part.text });
        }
        continue;
      }
      if (part.functionCall) {
        const fc = part.functionCall;
        const id = fc.id ?? `call_${ulid()}`;
        const name = fc.name ?? "";
        const args = (fc.args ?? {}) as Record<string, unknown>;
        const signature = (part as { thoughtSignature?: string }).thoughtSignature;
        const providerMetadata =
          signature !== undefined ? { google: { thoughtSignature: signature } } : undefined;
        output.push({
          type: "tool_use",
          toolUseId: id,
          name,
          input: args,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
        toolCalls.push({
          id,
          name,
          input: args,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
      }
    }
  }

  const stopReason = mapFinishReason(candidate?.finishReason);
  const usage = toUsageStats(raw.usageMetadata);

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION_LITERAL,
    output,
    stopReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function isGoogleResponse(v: unknown): v is GenerateContentResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as { candidates?: unknown };
  return Array.isArray(o.candidates);
}

function toUsageStats(usage: GenerateContentResponse["usageMetadata"]): UsageStats {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const totalTokens = usage.totalTokenCount ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(usage.thoughtsTokenCount != null ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
    ...(usage.cachedContentTokenCount != null
      ? { cachedInputTokens: usage.cachedContentTokenCount }
      : {}),
  };
}

// ============================================================================
// Stream accumulator — single-pass: build ContentBlock[] during streaming.
// ============================================================================

interface AccumToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}

type AccumBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_use"; call: AccumToolCall };

/**
 * Single-pass accumulator that builds the IR-shaped `ContentBlock[]`
 * directly during streaming. Avoids the dual-walk pattern in older
 * adapters (provider chunks → synthesized raw → ContentBlock[]).
 * `toResponse` synthesizes a GenerateContentResponse only when callers
 * still need it (non-streaming-path consumers + tests).
 */
class GoogleStreamAccumulator {
  private blocks: AccumBlock[] = [];
  private currentText: AccumBlock | null = null;
  private currentReasoning: AccumBlock | null = null;
  private finish: FinishReason | undefined;
  private usage: GenerateContentResponse["usageMetadata"];

  /**
   * Full-walk accumulation used by `executeStreamBody` (the
   * `run()` path) which does not emit AdapterDeltas itself —
   * accumulation IS the entire job there. Walks each part and
   * records text / reasoning / functionCalls / usage / finishReason.
   * Idempotent on no-op chunks.
   *
   * The standalone `executeStream` method instead calls the more
   * granular `startTextBlock` / `appendText` / etc. directly during
   * its single-pass emit-and-accumulate loop — DO NOT also call
   * `pushChunk` there, or content would double-accumulate.
   */
  pushChunk(chunk: GenerateContentResponse): void {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      const isThought = (part as { thought?: boolean }).thought === true;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (isThought) {
          if (this.currentReasoning === null) this.startReasoningBlock();
          this.appendReasoning(part.text);
        } else {
          if (this.currentText === null) this.startTextBlock();
          this.appendText(part.text);
        }
        continue;
      }
      if (part.functionCall) {
        const fc = part.functionCall;
        this.recordToolCall({
          callId: fc.id ?? `call_${ulid()}`,
          name: fc.name ?? "",
          input: (fc.args ?? {}) as Record<string, unknown>,
          ...((part as { thoughtSignature?: string }).thoughtSignature !== undefined
            ? {
                thoughtSignature: (part as { thoughtSignature?: string }).thoughtSignature!,
              }
            : {}),
        });
      }
    }
    if (candidate?.finishReason) {
      this.setFinishReason(candidate.finishReason);
    }
    if (chunk.usageMetadata) {
      this.setUsage(chunk.usageMetadata);
    }
  }

  startTextBlock(): void {
    const block: AccumBlock = { kind: "text", text: "" };
    this.blocks.push(block);
    this.currentText = block;
    this.currentReasoning = null;
  }

  appendText(text: string): void {
    if (!this.currentText) this.startTextBlock();
    (this.currentText as { text: string }).text += text;
  }

  startReasoningBlock(): void {
    const block: AccumBlock = { kind: "reasoning", text: "" };
    this.blocks.push(block);
    this.currentReasoning = block;
    this.currentText = null;
  }

  appendReasoning(text: string): void {
    if (!this.currentReasoning) this.startReasoningBlock();
    (this.currentReasoning as { text: string }).text += text;
  }

  recordToolCall(call: AccumToolCall): void {
    this.blocks.push({ kind: "tool_use", call });
    this.currentText = null;
    this.currentReasoning = null;
  }

  currentTextBuffer(): string {
    return this.currentText?.kind === "text" ? this.currentText.text : "";
  }

  currentReasoningBuffer(): string {
    return this.currentReasoning?.kind === "reasoning" ? this.currentReasoning.text : "";
  }

  setFinishReason(reason: FinishReason): void {
    this.finish = reason;
  }

  setUsage(usage: GenerateContentResponse["usageMetadata"]): void {
    this.usage = usage;
  }

  toContentBlocks(): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const block of this.blocks) {
      if (block.kind === "text") {
        if (block.text.length > 0) out.push({ type: "text", text: block.text });
      } else if (block.kind === "reasoning") {
        if (block.text.length > 0) out.push({ type: "reasoning", text: block.text });
      } else {
        const { call } = block;
        const providerMetadata =
          call.thoughtSignature !== undefined
            ? { google: { thoughtSignature: call.thoughtSignature } }
            : undefined;
        out.push({
          type: "tool_use",
          toolUseId: call.callId,
          name: call.name,
          input: call.input,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
      }
    }
    return out;
  }

  toResponse(modelHint: string): GenerateContentResponse {
    const parts: Part[] = [];
    for (const block of this.blocks) {
      if (block.kind === "text") {
        if (block.text.length > 0) parts.push({ text: block.text });
      } else if (block.kind === "reasoning") {
        if (block.text.length > 0) parts.push({ text: block.text, thought: true } as Part);
      } else {
        const { call } = block;
        const fcPart: Part = {
          functionCall: { id: call.callId, name: call.name, args: call.input },
        };
        if (call.thoughtSignature !== undefined) {
          (fcPart as { thoughtSignature?: string }).thoughtSignature = call.thoughtSignature;
        }
        parts.push(fcPart);
      }
    }
    return {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: this.finish ?? FinishReason.STOP,
          index: 0,
        },
      ],
      modelVersion: modelHint,
      ...(this.usage !== undefined ? { usageMetadata: this.usage } : {}),
    } as GenerateContentResponse;
  }
}

// ============================================================================
// Stop-reason mapping
// ============================================================================

/**
 * Map Google's full FinishReason enum (incl. SAFETY, RECITATION,
 * MALFORMED_FUNCTION_CALL, MISSING_THOUGHT_SIGNATURE, IMAGE_* etc.)
 * to the normalized `LanguageModelStopReason`. Mirrors v1's table.
 */
function mapFinishReason(
  reason: FinishReason | string | null | undefined,
): LanguageModelStopReason {
  if (!reason) return "end";
  switch (reason) {
    case FinishReason.STOP:
    case "STOP":
      return "end";
    case FinishReason.MAX_TOKENS:
    case "MAX_TOKENS":
      return "max_tokens";
    case FinishReason.SAFETY:
    case "SAFETY":
    case FinishReason.RECITATION:
    case "RECITATION":
    case FinishReason.BLOCKLIST:
    case "BLOCKLIST":
    case FinishReason.PROHIBITED_CONTENT:
    case "PROHIBITED_CONTENT":
    case FinishReason.SPII:
    case "SPII":
    case FinishReason.IMAGE_SAFETY:
    case "IMAGE_SAFETY":
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case "IMAGE_PROHIBITED_CONTENT":
    case FinishReason.IMAGE_RECITATION:
    case "IMAGE_RECITATION":
    case FinishReason.LANGUAGE:
    case "LANGUAGE":
      return "content_filter";
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "TOO_MANY_TOOL_CALLS":
    case "MISSING_THOUGHT_SIGNATURE":
      // Spec's LanguageModelStopReason has no "error" — fold to "other"
      // with the underlying reason recoverable from raw if needed.
      return "other";
    default:
      return "other";
  }
}

// ============================================================================
// Schema sanitization — Gemini supports a strict JSON Schema subset.
// ============================================================================

/**
 * Sanitize a JSON Schema for Gemini's function-declaration format.
 * Recursively strips unsupported features while preserving intent.
 *
 * Removed: $ref, $defs/$definitions, additionalItems, propertyNames.
 * additionalProperties: {} dropped, false retained, {schema} dropped.
 * items: [array] (tuple) collapsed to first item's schema.
 * anyOf/oneOf with $ref entries: filtered out; single → inlined; all
 * $ref → object fallback.
 */
export function sanitizeSchemaForGemini(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 15) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item, depth + 1));
  }
  const obj = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (
      key === "$ref" ||
      key === "$defs" ||
      key === "$definitions" ||
      key === "additionalItems" ||
      key === "propertyNames"
    ) {
      continue;
    }

    if (key === "additionalProperties") {
      if (value && typeof value === "object" && Object.keys(value).length === 0) {
        continue;
      }
      if (value === false) {
        result[key] = value;
        continue;
      }
      continue;
    }

    if (key === "items" && Array.isArray(value)) {
      const first = value[0];
      result[key] = first ? sanitizeSchemaForGemini(first, depth + 1) : { type: "string" };
      continue;
    }

    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      const cleaned = value
        .filter((v) => !(v && typeof v === "object" && "$ref" in v))
        .map((v) => sanitizeSchemaForGemini(v, depth + 1));
      if (cleaned.length === 0) {
        result["type"] = "object";
      } else if (cleaned.length === 1) {
        Object.assign(result, cleaned[0] as Record<string, unknown>);
      } else {
        result[key] = cleaned;
      }
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGemini(value, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function ensureObjectSchema(params: unknown): unknown {
  if (!params || typeof params !== "object") return { type: "object" };
  const obj = params as Record<string, unknown>;
  if (!obj["type"]) return { ...obj, type: "object" };
  return obj;
}
