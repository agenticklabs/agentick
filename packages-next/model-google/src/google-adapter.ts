/**
 * `google(model?, options?)` — the Gemini `LanguageModelAdapter`
 * (ADR 52), backed by the `@google/genai` SDK. Supports the Gemini
 * Developer API (apiKey path) and Vertex AI (project/location/auth
 * path).
 *
 * A plain Promise/AsyncIterable-shaped object consumed by
 * `LanguageModelExecutor` — zero Effect, zero substrate. Gemini
 * dialect handled at this layer:
 * - `sanitizeSchemaForGemini` — strict JSON-Schema subset for tool input
 * - `thoughtSignature` round-trip (Gemini 3+ thinking; opaque signature
 *   that MUST be sent back on subsequent turns to avoid
 *   MISSING_THOUGHT_SIGNATURE)
 * - `part.thought` flag routes text parts to the reasoning channel
 *   (Gemini 2.5+ thinking models)
 * - `thoughtsTokenCount` + `cachedContentTokenCount` usage surfacing
 * - Synthesized block boundaries (Gemini chunks carry none) — see
 *   `mapChunk`
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import {
  GoogleGenAI,
  FinishReason,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type GroundingMetadata,
  type Part,
  type Tool as GoogleTool,
  type FunctionDeclaration,
} from "@google/genai";

import { ulid } from "@agentick/utils-next";
import type {
  Citation,
  ContentBlock,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelStopReason,
  LanguageModelTool,
  MediaSource,
  NormalizeInput,
  Source,
  TextBlock,
  ToolCall,
  UsageStats,
} from "@agentick/spec-next";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec-next";

import {
  createSourceInterner,
  type CustomBlockDefinition,
  defaultFinalizeStream,
  type DeltaTransform,
  type LanguageModelAdapter,
  type SourceInterner,
  type StreamAccumulatorView,
  StreamTagParser,
  type StreamTagHandler,
  thinkTagTransform,
} from "@agentick/model-next";
import type { AdapterDelta } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

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

export interface GoogleAdapterOptions {
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

export type { CustomBlockDefinition } from "@agentick/model-next";

// ============================================================================
// Internals
// ============================================================================

const SPEC_VERSION_LITERAL = SPEC_VERSION;
const DEFAULT_MODEL = "gemini-2.5-flash";

// ============================================================================
// google() — the adapter factory
// ============================================================================

/**
 * Provider-private state for Google's streaming pipeline. Google's
 * `GenerateContentResponse` chunks don't carry explicit block
 * boundaries — we infer them by watching the type (text vs thought vs
 * functionCall) of each `part`. The active block + counter live here.
 */
interface GoogleStreamState {
  blockIndex: number;
  activeKind: "text" | "reasoning" | null;
  finishReasonRaw: string | null;
  /** Per-tool-call thoughtSignature carry (Gemini 2.5+). */
  thoughtSignatureByCallId: Map<string, string>;
}

function getGoogleState(accum: StreamAccumulatorView): GoogleStreamState {
  let s = accum.providerExtra as GoogleStreamState | undefined;
  if (!s) {
    s = {
      blockIndex: -1,
      activeKind: null,
      finishReasonRaw: null,
      thoughtSignatureByCallId: new Map(),
    };
    accum.providerExtra = s;
  }
  return s;
}

/**
 * Construct the Gemini `LanguageModelAdapter`. Pass it wherever an
 * adapter is accepted — the app's `executor:` slot (wrapped in the ONE
 * `LanguageModelExecutor`), `generate({ model: google("gemini-2.5-pro"),
 * ... })`, or a hand-constructed executor.
 *
 * The SDK client is constructed lazily on first use, so declaring the
 * adapter does not require `GOOGLE_API_KEY` / `GEMINI_API_KEY` until a
 * call actually happens (inject `options.client` to bypass).
 */
export function google(
  model?: string,
  options: GoogleAdapterOptions = {},
): LanguageModelAdapter<GenerateContentResponse, GenerateContentResponse> {
  const defaultModel = model;
  const parseThinkTags = options.parseThinkTags ?? false;
  const customBlocks = options.customBlocks;
  const target: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "google",
    modelId: model ?? DEFAULT_MODEL,
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonSchema: true,
      supportsVision: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
    },
  };

  let clientMemo: GoogleGenAI | undefined = options.client;
  const client = (): GoogleGenAI => (clientMemo ??= new GoogleGenAI(buildClientOptions(options)));

  return {
    provider: "google",
    target,
    streamByDefault: options.stream ?? false,
    ...(customBlocks !== undefined ? { customBlocks } : {}),

    buildParams(input: LanguageModelInput, target: ExecutionTarget): GenerateContentParameters {
      return toGoogleParams(input, target, defaultModel);
    },

    call(params: unknown, _signal: AbortSignal | undefined): Promise<GenerateContentResponse> {
      // Google SDK doesn't accept an abort signal on the call directly;
      // aborts surface as the stream iterator throwing. We rely on the
      // executor's in-flight tracking + the user-supplied AbortController.
      return client().models.generateContent(params as GenerateContentParameters);
    },

    openStream(
      params: unknown,
      _signal: AbortSignal | undefined,
    ): Promise<AsyncIterable<GenerateContentResponse>> {
      // SDK doesn't accept signal here; the iterator throws when the
      // bridged abort fires.
      return client().models.generateContentStream(
        params as GenerateContentParameters,
      ) as unknown as Promise<AsyncIterable<GenerateContentResponse>>;
    },

    /**
     * Map a Google chunk's parts to deltas. Gemini doesn't use explicit
     * block boundaries — we synthesize them: when the kind of content
     * (text vs reasoning vs functionCall) changes, we close the previous
     * block and open a new one. State (block index, active kind,
     * `thoughtSignature`) lives on `accum.providerExtra`.
     */
    mapChunk(
      chunk: GenerateContentResponse,
      accum: StreamAccumulatorView,
    ): readonly AdapterDelta[] {
      const state = getGoogleState(accum);
      const out: AdapterDelta[] = [];

      // Capture `modelVersion` via synthetic message-start (only first time).
      if (chunk.modelVersion && !accum.messageStarted) {
        out.push({ type: "message-start", role: "assistant", model: chunk.modelVersion });
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) return out;
      const parts = candidate.content?.parts ?? [];

      // closeActive only fires for mid-chunk block transitions (text →
      // reasoning, text → functionCall, etc.). For the end-of-stream
      // close, we let the base's `finalizeStream` handle it — at finalize
      // time the accumulator is fully consistent. The `content` /
      // `reasoning` summary deltas are NOT emitted here because
      // accumulator text isn't applied until AFTER mapChunk returns
      // (Stream.tap runs per-delta); finalize emits them correctly.
      const closeActive = (): void => {
        if (state.activeKind === "text") {
          out.push({ type: "content-end", blockIndex: state.blockIndex });
        } else if (state.activeKind === "reasoning") {
          out.push({ type: "reasoning-end", blockIndex: state.blockIndex });
        }
        state.activeKind = null;
      };

      for (const part of parts) {
        const isThought = (part as { thought?: boolean }).thought === true;

        // Text path
        if (typeof part.text === "string" && part.text.length > 0) {
          if (isThought) {
            if (state.activeKind !== "reasoning") {
              closeActive();
              state.blockIndex += 1;
              out.push({ type: "reasoning-start", blockIndex: state.blockIndex });
              state.activeKind = "reasoning";
            }
            out.push({ type: "reasoning-delta", blockIndex: state.blockIndex, delta: part.text });
          } else {
            if (state.activeKind !== "text") {
              closeActive();
              state.blockIndex += 1;
              out.push({ type: "content-start", blockIndex: state.blockIndex, blockType: "text" });
              state.activeKind = "text";
            }
            out.push({ type: "content-delta", blockIndex: state.blockIndex, delta: part.text });
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
          if (signature !== undefined) state.thoughtSignatureByCallId.set(callId, signature);
          state.blockIndex += 1;
          out.push({
            type: "tool-call-start",
            callId,
            name,
            blockIndex: state.blockIndex,
          });
          const jsonDelta = JSON.stringify(args);
          if (jsonDelta !== "{}") {
            out.push({ type: "tool-call-delta", callId, delta: jsonDelta });
          }
          out.push({ type: "tool-call-end", callId });
          const toolDelta: AdapterDelta = {
            type: "tool-call",
            callId,
            name,
            input: args,
            ...(signature !== undefined
              ? ({ providerMetadata: { google: { thoughtSignature: signature } } } as Record<
                  string,
                  unknown
                >)
              : {}),
          } as AdapterDelta;
          out.push(toolDelta);
        }
      }

      if (candidate.finishReason) {
        state.finishReasonRaw = candidate.finishReason;
        // Don't close blocks or emit message-end here — `finalizeStream`
        // does both with consistent accumulator state. We just emit a
        // `usage` delta so the base's finalize message-end carries the
        // right token counts.
        const usage = toUsageStats(chunk.usageMetadata);
        out.push({ type: "usage", usage });
      }
      return out;
    },

    /**
     * Late stop-reason mapping: the executor's default finalize would
     * emit `message-end` with `"end"` because no in-stream delta
     * carried Google's `finishReason`. Map it onto the view, then run
     * the executor's default finalization.
     */
    finalizeStream(accum: StreamAccumulatorView): readonly AdapterDelta[] {
      const state = getGoogleState(accum);
      if (state.finishReasonRaw && accum.stopReason === "end") {
        accum.stopReason = mapFinishReason(state.finishReasonRaw);
      }
      return defaultFinalizeStream(accum);
    },

    /**
     * Reconstruct a canonical `GenerateContentResponse` from accumulator
     * state. Reassembles `candidates[0].content.parts` by walking blocks
     * in index order; preserves `thoughtSignature` on tool-call parts.
     */
    reconstructRaw(
      accum: StreamAccumulatorView,
      modelSeen: string | undefined,
    ): GenerateContentResponse {
      const state = getGoogleState(accum);
      const parts: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
        thoughtSignature?: string;
      }> = [];

      const allIndices = new Set<number>([
        ...accum.textByBlock.keys(),
        ...accum.reasoningByBlock.keys(),
        ...Array.from(accum.toolCalls.values()).map((c) => c.blockIndex),
      ]);
      const sorted = [...allIndices].sort((a, b) => a - b);
      for (const idx of sorted) {
        const text = accum.textByBlock.get(idx);
        if (text !== undefined && text.length > 0) {
          parts.push({ text });
          continue;
        }
        const reasoning = accum.reasoningByBlock.get(idx);
        if (reasoning !== undefined && reasoning.length > 0) {
          parts.push({ text: reasoning, thought: true });
          continue;
        }
        const tc = [...accum.toolCalls.values()].find((c) => c.blockIndex === idx);
        if (tc) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = tc.argsBuffer
              ? (JSON.parse(tc.argsBuffer) as Record<string, unknown>)
              : ((tc.input as Record<string, unknown>) ?? {});
          } catch {
            parsed = (tc.input as Record<string, unknown>) ?? {};
          }
          const sig = state.thoughtSignatureByCallId.get(tc.callId);
          parts.push({
            functionCall: { id: tc.callId, name: tc.name, args: parsed },
            ...omitUndefined({ thoughtSignature: sig }),
          });
        }
      }

      return {
        candidates: [
          {
            content: { role: "model", parts },
            finishReason: state.finishReasonRaw ?? "STOP",
          },
        ],
        modelVersion: modelSeen ?? defaultModel ?? target.modelId,
        usageMetadata: {
          promptTokenCount: accum.usage.inputTokens,
          candidatesTokenCount: accum.usage.outputTokens,
          totalTokenCount: accum.usage.totalTokens,
          ...omitUndefined({
            thoughtsTokenCount: accum.usage.reasoningTokens,
            cachedContentTokenCount: accum.usage.cachedInputTokens,
          }),
        },
      } as unknown as GenerateContentResponse;
    },

    adapterTransforms(): readonly DeltaTransform[] {
      return parseThinkTags ? [thinkTagTransform()] : [];
    },

    normalize(raw: GenerateContentResponse): LanguageModelExecutionResult {
      return normalizeImpl({ targetOutput: raw, target });
    },

    /**
     * Non-streaming + tag routing: same pattern as OpenAI/Anthropic.
     * Streaming path's transforms didn't run, so extract tags from each
     * text part here.
     */
    postProcessForNormalize(raw: GenerateContentResponse): GenerateContentResponse {
      if (!parseThinkTags && !customBlocks) return raw;
      const candidate = raw.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (!parts) return raw;
      const newParts: typeof parts = [];
      let reasoningCarry = "";
      for (const part of parts) {
        if (typeof part.text === "string" && (part as { thought?: boolean }).thought !== true) {
          const cleaned = applyTagsToText(part.text, parseThinkTags, customBlocks);
          if (cleaned) {
            reasoningCarry += cleaned.reasoning;
            if (cleaned.text.length > 0) newParts.push({ ...part, text: cleaned.text });
          } else {
            newParts.push(part);
          }
        } else {
          newParts.push(part);
        }
      }
      if (reasoningCarry.length > 0) {
        newParts.unshift({ text: reasoningCarry, thought: true });
      }
      return {
        ...raw,
        candidates: [
          {
            ...candidate,
            content: { ...candidate?.content, parts: newParts },
          },
        ],
      } as GenerateContentResponse;
    },
  };
}

/**
 * Tag extraction for Google's non-streaming post-process. Same shape
 * as the OpenAI/Anthropic helpers.
 */
function applyTagsToText(
  text: string,
  parseThinkTags: boolean,
  customBlocks: Readonly<Record<string, CustomBlockDefinition>> | undefined,
): { text: string; reasoning: string } | null {
  const handlers: Record<string, StreamTagHandler> = {};
  const reasoningTags = new Set<string>();
  if (parseThinkTags) {
    handlers["think"] = {};
    reasoningTags.add("think");
  }
  if (customBlocks) {
    for (const [key, def] of Object.entries(customBlocks)) {
      const tagName = def.tag ?? key;
      const h: StreamTagHandler = {};
      if (def.onStart) h.onStart = def.onStart;
      if (def.onContent) h.onContent = def.onContent;
      if (def.onSelfClosing) h.onSelfClosing = def.onSelfClosing;
      handlers[tagName] = h;
    }
  }
  if (Object.keys(handlers).length === 0) return null;
  const parser = new StreamTagParser({ tags: handlers });
  const events = [...parser.process(text), ...parser.flush()];
  let cleanText = "";
  let reasoning = "";
  for (const ev of events) {
    if (ev.type === "text") cleanText += ev.content;
    else if (ev.type === "block" && reasoningTags.has(ev.tag)) reasoning += ev.content;
  }
  return { text: cleanText, reasoning };
}

// ============================================================================
// Client construction
// ============================================================================

function buildClientOptions(opts: GoogleAdapterOptions): GoogleGenAIOptions {
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
// IR → Google params
// ============================================================================

function toGoogleParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
): GenerateContentParameters {
  const { systemInstruction, contents } = toGoogleContents(input.messages);
  const fnTools = input.tools && input.tools.length > 0 ? toGoogleTools(input.tools) : [];
  // Pass D request-half: append this adapter's own provider-EXECUTED tool
  // slice (`provider === "google"`) onto the native `tools` array. Google's
  // grounding tools are shaped as `{ [key]: config }` (e.g. `{ googleSearch:
  // {} }`, `{ codeExecution: {} }`) — NOT `{ type }` — and ride as their own
  // `Tool` entries ALONGSIDE the single function-declaration `Tool`. Map each
  // to `{ [pt.type]: pt.config ?? {} }` verbatim. Other providers' slices are
  // ignored (each adapter owns exactly its own key).
  const providerTools = buildGoogleProviderTools(input.providerTools);
  const tools = [...fnTools, ...providerTools];

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
  if (tools.length > 0) config.tools = tools;

  // G5 — adopter escape hatch. `input.providerOptions` (project-time
  // fold of tree over target, #176) wins over the target's own bag;
  // merged defensively so a direct `buildParams(input, target)` still
  // applies the escape hatch. Spread last onto config.
  const overrides = mergeProviderOptions(target.providerOptions, input.providerOptions)?.google;
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
      // Canonical `CacheHint` (`message.cache` / per-part `cache`) is a
      // deliberate NO-OP for Gemini (#212). Unlike Anthropic's inline
      // `cache_control`, Gemini caching is either implicit (automatic
      // prefix caching on 2.5 models — no translation needed, same posture
      // as OpenAI) or explicit, which requires a pre-created `CachedContent`
      // RESOURCE NAME the canonical hint cannot synthesize. Adopters wiring
      // explicit caching pass that resource via the
      // `providerOptions.google.cachedContent` escape hatch (folded onto
      // `config` in `toGoogleParams`). The hint's text still projects here;
      // only the (untranslatable) hint metadata is dropped.
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
        case "document": {
          const partOut = googlePartFromSource(part.source, part.mediaType, "application/pdf");
          if (partOut) parts.push(partOut);
          break;
        }
        case "audio": {
          const partOut = googlePartFromSource(part.source, part.mediaType, "audio/mpeg");
          if (partOut) parts.push(partOut);
          break;
        }
        case "video": {
          const partOut = googlePartFromSource(part.source, part.mediaType, "video/mp4");
          if (partOut) parts.push(partOut);
          break;
        }
        // TODO(adr-57-followup: google reasoning input): Gemini carries
        // reasoning round-trip via `thoughtSignature` on the functionCall
        // part (below), not a replayed reasoning content part — a bare
        // reasoning part is dropped rather than flattened to a text bomb.
        case "tool_use": {
          // Round-trip: `thoughtSignature` rides the INPUT part's
          // `providerOptions.google` (ADR 57 §2 — projected from the
          // block's `providerMetadata` at `messagePartFromBlock`).
          const signature = (
            part.providerOptions as Record<string, Record<string, unknown>> | undefined
          )?.["google"]?.["thoughtSignature"];
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

/**
 * Project a document/audio/video {@link MediaSource} to a Gemini `Part`.
 * Ports v1's `google.ts:454` shape: base64 → `inlineData`; url / gcs /
 * files-API reference → `fileData` with a `fileUri`. Mirrors the image
 * path (`imagePartFromUrl`).
 */
function googlePartFromSource(
  source: MediaSource,
  mediaType: string | undefined,
  defaultMime: string,
): Part | null {
  switch (source.type) {
    case "base64":
      return {
        inlineData: { mimeType: source.mimeType ?? mediaType ?? defaultMime, data: source.data },
      };
    case "url":
      return {
        fileData: { mimeType: source.mimeType ?? mediaType ?? defaultMime, fileUri: source.url },
      };
    case "gcs":
      return {
        fileData: {
          mimeType: source.mimeType ?? mediaType ?? defaultMime,
          fileUri: `gs://${source.bucket}/${source.object}`,
        },
      };
    case "reference":
      return {
        fileData: {
          mimeType: source.mimeType ?? mediaType ?? defaultMime,
          fileUri: source.fileId,
        },
      };
    default:
      // s3 has no native Gemini source — TODO(adr-57-followup: google s3
      // staged sources).
      return null;
  }
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
      ...omitUndefined({ description: t.description }),
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

/**
 * Pass D request-half: map the `provider === "google"` slice of
 * `input.providerTools` onto Gemini's native grounding-tool shape. Unlike
 * function tools (one `Tool` with `functionDeclarations`), Google grounding
 * tools are keyed objects — `{ googleSearch: {} }`, `{ codeExecution: {} }`,
 * `{ urlContext: {} }` — each a distinct `Tool` in `config.tools`. Map each
 * wire entry to `{ [pt.type]: pt.config ?? {} }` verbatim; passthrough, no
 * per-tool knowledge. Other providers' slices are ignored.
 */
function buildGoogleProviderTools(
  providerTools: LanguageModelInput["providerTools"],
): GoogleTool[] {
  if (!providerTools) return [];
  const out: GoogleTool[] = [];
  for (const pt of providerTools) {
    if (pt.provider !== "google") continue;
    out.push({ [pt.type]: pt.config ?? {} } as unknown as GoogleTool);
  }
  return out;
}

// ============================================================================
// GenerateContentResponse → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isGoogleResponse(raw)) {
    throw new Error("normalize expected Google GenerateContentResponse shape");
  }
  // Provenance-half (Pass D): googleSearch grounding is response METADATA, not a
  // discrete provider tool_result — `candidate.groundingMetadata` carries
  // `groundingSupports[]` anchoring spans of the assistant text to
  // `groundingChunks[].web` sources. It is mapped to `Citation[]` on the annotated
  // text block below (keyed by `segment.partIndex`). Because grounding is metadata
  // and NOT a `tool_result`, there is deliberately NO `executedBy` stamp for it —
  // this is the honest shape of Google grounding, not a gap. Function `tool_use`
  // (functionCall parts) are the only dispatchable calls; grounding emits none.
  //
  // TODO(pass-d): codeExecution provenance (`executableCode` /
  //   `codeExecutionResult` parts) IS a provider-run tool result that would carry
  //   `executedBy: "provider:google"`, but it is out of scope for this
  //   grounding-citation pass and un-mapped here. Narrowed, greppable.
  const candidate = raw.candidates?.[0];
  const output: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  // part-index → output-block index, so grounding citations (which reference a
  // `segment.partIndex`) can be attached to the correct text block.
  const partIndexToOutputIndex = new Map<number, number>();

  if (candidate?.content?.parts) {
    const parts = candidate.content.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      const isThought = (part as { thought?: boolean }).thought === true;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (isThought) {
          output.push({ type: "reasoning", text: part.text });
        } else {
          partIndexToOutputIndex.set(pi, output.length);
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

  // One interner per normalize (per turn): a grounding chunk (web source) cited
  // by many supports / across many text blocks mints one `Source` with one
  // turn-stable id, so the message-level roll-up dedupes it.
  const interner = createSourceInterner();
  attachGroundingCitations(output, partIndexToOutputIndex, candidate?.groundingMetadata, interner);

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

/**
 * Pass D provenance-half: map Google's `candidate.groundingMetadata` onto
 * canonical {@link Citation}s and attach them to the annotated text blocks.
 *
 * Each `groundingSupports[]` entry anchors a `segment` (a span of the assistant
 * text, byte offsets `startIndex`/`endIndex` within `segment.partIndex`) to one
 * or more `groundingChunkIndices` into `groundingChunks[]`. We emit one
 * {@link Citation} per (support × chunk) pair so each cited web source retains
 * its own `confidenceScores[i]` — the referenced {@link Source} (minted / deduped
 * via the turn-scoped `interner`) from `chunk.web{uri,title}`, `citedText` from
 * `segment.text`, `range` from the segment span. Citations are grouped by
 * `segment.partIndex` (defaulting to the first text block when the provider omits
 * it) and attached to the corresponding text block alongside that block's deduped
 * referenced {@link BaseContentBlock.sources}.
 *
 * Grounding is METADATA, not a `tool_result` — no `executedBy` stamp (see the
 * normalizeImpl note). Mutates `output` in place.
 */
function attachGroundingCitations(
  output: ContentBlock[],
  partIndexToOutputIndex: Map<number, number>,
  grounding: GroundingMetadata | undefined,
  interner: SourceInterner,
): void {
  if (!grounding) return;
  const supports = grounding.groundingSupports;
  if (!supports || supports.length === 0) return;
  const chunks = grounding.groundingChunks ?? [];

  const firstTextPartIndex =
    partIndexToOutputIndex.size > 0 ? [...partIndexToOutputIndex.keys()][0] : undefined;
  const byPartIndex = new Map<number, Citation[]>();
  // Per-block deduped Source set (keyed by turn-stable id), grouped by partIndex.
  const sourcesByPartIndex = new Map<number, Map<string, Source>>();

  for (const support of supports) {
    const segment = support.segment;
    const chunkIndices = support.groundingChunkIndices ?? [];
    const confidences = support.confidenceScores ?? [];
    const partIndex = segment?.partIndex ?? firstTextPartIndex ?? 0;
    const range =
      segment?.startIndex != null && segment.endIndex != null
        ? { start: segment.startIndex, end: segment.endIndex }
        : undefined;

    for (let i = 0; i < chunkIndices.length; i++) {
      const web = chunks[chunkIndices[i]]?.web;
      const source = interner.intern({
        ...(web?.uri ? { url: web.uri } : {}),
        ...(web?.title ? { title: web.title } : {}),
      });
      let blockSources = sourcesByPartIndex.get(partIndex);
      if (!blockSources) {
        blockSources = new Map<string, Source>();
        sourcesByPartIndex.set(partIndex, blockSources);
      }
      blockSources.set(source.id, source);
      const confidence = confidences[i];
      const citation: Citation = {
        sourceId: source.id,
        ...(segment?.text ? { citedText: segment.text } : {}),
        ...(range ? { range } : {}),
        ...(typeof confidence === "number" ? { confidence } : {}),
      };
      const bucket = byPartIndex.get(partIndex);
      if (bucket) bucket.push(citation);
      else byPartIndex.set(partIndex, [citation]);
    }
  }

  for (const [partIndex, citations] of byPartIndex) {
    const oi = partIndexToOutputIndex.get(partIndex);
    if (oi === undefined) continue;
    const sources = [...(sourcesByPartIndex.get(partIndex)?.values() ?? [])];
    output[oi] = { ...(output[oi] as TextBlock), citations, sources };
  }
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
