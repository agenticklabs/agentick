/**
 * Canonical `ProjectInput → LanguageModelInput` projection.
 *
 * Used as the default by `BaseLanguageModelExecutor.projectImpl` and by
 * `defineExecutor`'s `CallbackLanguageModelExecutor`. Concrete provider
 * executors override `projectImpl` when their system-message or
 * tool-declaration shape requires it (e.g., Anthropic preserves
 * per-section `providerMetadata` by emitting one text part per section).
 *
 * The fold:
 *   - All `section` entries → a single system message (markdown-flavored).
 *   - All `message` entries → corresponding chat messages.
 *   - All `tool` declarations with `model` exposure → `tools[]`.
 *
 * Pure / deterministic. No provider dependencies.
 */

import type {
  ContentBlock,
  ContextEntry,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelParameters,
  LanguageModelTool,
  MediaSource,
  ProjectInput,
  RenderedTree,
  SectionEntry,
  ToolDeclaration,
} from "@agentick/spec-next";
import { mergeProviderOptions, TOOL_NARRATION_FIELD, toJsonSchema } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

export function defaultProject(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  // Tools come from `input.tools` — the loop's per-tick compile result
  // (precedence-resolved across gateway/app/session/execution/extension/
  // reconciler). The IR's `compiled.declarations.tools` records what
  // the reconciler emitted but is NOT the canonical source for the
  // model's visible tool list. See `ProjectInput.tools` for context.
  const tools = buildTools(input.tools, input.narrate);
  const parameters = buildParameters(input.compiled);
  // #176: fold `tree.providerOptions` OVER `target.providerOptions`
  // (tree/per-render wins) onto the request-level channel. Previously
  // orphaned — the reconciler collected `<ProviderOptions>` into
  // `RenderedTree.providerOptions` but nothing threaded it into the
  // executor input; adapters saw only `target.providerOptions`.
  const providerOptions = mergeProviderOptions(
    input.target.providerOptions,
    input.compiled.providerOptions,
  );
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...omitUndefined({ parameters, providerOptions }),
  };
}

/**
 * Lift `tree.config` (generation params) into `LanguageModelParameters`.
 * Returns `undefined` when `tree.config` is absent or empty so callers
 * spread conditionally — `LanguageModelInput.parameters` is only set
 * when it's meaningful.
 */
export function buildParameters(tree: RenderedTree): LanguageModelParameters | undefined {
  const cfg = tree.config;
  if (!cfg) return undefined;
  const params: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: ReadonlyArray<string>;
    responseFormat?: {
      type: "text" | "json" | "json_schema";
      schema?: Record<string, unknown>;
    };
  } = {};
  if (cfg.temperature !== undefined) params.temperature = cfg.temperature;
  if (cfg.maxOutputTokens !== undefined) params.maxOutputTokens = cfg.maxOutputTokens;
  if (cfg.topP !== undefined) params.topP = cfg.topP;
  if (cfg.frequencyPenalty !== undefined) params.frequencyPenalty = cfg.frequencyPenalty;
  if (cfg.presencePenalty !== undefined) params.presencePenalty = cfg.presencePenalty;
  if (cfg.stopSequences !== undefined) params.stopSequences = cfg.stopSequences;
  if (cfg.responseFormat !== undefined) {
    if (cfg.responseFormat.type === "json_schema") {
      params.responseFormat = {
        type: "json_schema",
        schema: cfg.responseFormat.schema as Record<string, unknown>,
      };
    } else {
      params.responseFormat = { type: cfg.responseFormat.type };
    }
  }
  return Object.keys(params).length > 0 ? (params as LanguageModelParameters) : undefined;
}

export function buildMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  const messages: LanguageModelMessage[] = [];
  const sections = tree.context.entries.filter((e): e is SectionEntry => e.kind === "section");
  // Cache-hinted sections need their boundaries preserved — emit one
  // text part per section with the hint on the part (#185). Otherwise
  // keep the single joined blob (compact, provider-friendly).
  if (sections.some((sec) => sec.metadata?.cache !== undefined)) {
    const parts = sections
      .map((sec) => ({ text: sectionText(sec), cache: sec.metadata?.cache }))
      .filter((p) => p.text.length > 0)
      .map((p) => ({
        type: "text" as const,
        text: p.text,
        ...(p.cache !== undefined ? { cache: p.cache } : {}),
      }));
    if (parts.length > 0) messages.push({ role: "system", content: parts });
  } else {
    const systemText = collectSectionText(tree.context.entries);
    if (systemText.length > 0) {
      messages.push({ role: "system", content: [{ type: "text", text: systemText }] });
    }
  }
  for (const entry of tree.context.entries) {
    if (entry.kind !== "message") continue;
    const cache = entry.metadata?.cache;
    // Message-level `providerMetadata` (adopter-stamped input knobs) rides
    // the INPUT channel `providerOptions` at the wire boundary — same
    // send/return split as per-block `providerMetadata` → part
    // `providerOptions` (#173, ADR 57 §2).
    const providerOptions = entry.metadata?.providerMetadata;
    messages.push({
      role: entry.role as LanguageModelMessage["role"],
      content: entry.content.map(messagePartFromBlock),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      ...(cache !== undefined ? { cache } : {}),
    });
  }
  return messages;
}

export function collectSectionText(entries: ReadonlyArray<ContextEntry>): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind !== "section") continue;
    const text = sectionText(e);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

export function sectionText(section: SectionEntry): string {
  const lines: string[] = [];
  if (section.title !== undefined) lines.push(`# ${section.title}`);
  for (const block of section.content) {
    if (block.type === "text") lines.push(block.text);
  }
  return lines.join("\n");
}

export function messagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  // Per-block `providerMetadata` (the canonical block's only knob
  // channel — adopter-stamped cacheControl AND model-produced opaque
  // round-trip data like `thoughtSignature`) projects onto the INPUT
  // part's `providerOptions` field (ADR 57 §2 — providerOptions is
  // "what you send"). The part's own `providerMetadata` is reserved for
  // the OUTPUT direction (`normalize`).
  const po =
    block.providerMetadata !== undefined ? { providerOptions: block.providerMetadata } : {};
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...po };
    case "image":
      return {
        type: "image",
        imageUrl: imageUrlFromSource(block.source, block.mimeType),
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "document":
      return {
        type: "document",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "audio":
      return {
        type: "audio",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "video":
      return {
        type: "video",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "reasoning":
      return {
        type: "reasoning",
        text: block.text,
        ...omitUndefined({ signature: block.signature }),
        ...po,
      };
    case "generated_image":
      // Replayed as input → reuse the `image` variant (ADR 57
      // §Taxonomy). Emit a data URI, NOT `JSON.stringify(block)` — the
      // latter dumped the entire base64 payload into a text token-bomb.
      return {
        type: "image",
        imageUrl: `data:${block.mimeType};base64,${block.data}`,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "generated_file":
      // Replayed as input → reuse the `document` variant (ADR 57
      // §Taxonomy). The generated file is addressed by URI.
      return {
        type: "document",
        source: { type: "url", url: block.uri, ...omitUndefined({ mimeType: block.mimeType }) },
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input,
        ...po,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content.map(messagePartFromBlock),
        ...omitUndefined({ isError: block.isError }),
        ...po,
      };
    case "task_ref":
      // Drop-in projection — the executor surface still only knows
      // text/image/tool_use/tool_result, so a task_ref lands as a
      // text block whose body is the historical JSON shape with the
      // `_kind: "session_task_ref"` discriminator. Adopters that
      // already parse this JSON continue to work; consumers that
      // pattern-match on `block.type === "task_ref"` operate on the
      // structured block BEFORE this projection.
      return {
        type: "text",
        text: JSON.stringify({
          _kind: "session_task_ref",
          taskId: block.taskId,
          status: block.status,
          ...omitUndefined({
            statusMessage: block.statusMessage,
            ttl: block.ttl,
            pollInterval: block.pollInterval,
          }),
        }),
        ...po,
      };
    case "resource": {
      // Resource → text for model consumption (ADR 62). MCP resource content
      // isn't natively model-consumable: a text resource inlines its text; a
      // blob surfaces a `uri` + `mimeType` descriptor (binary can't be inlined
      // as text usefully). Was previously falling through to the default and
      // JSON-dumping the whole `{ type, resource }` wrapper.
      // TODO(#237 / ADR 62 follow-on): add a `supportsDocuments` capability +
      // thread it here so a blob resource → a `document` part when supported,
      // else this text descriptor.
      const r = block.resource;
      return {
        type: "text",
        text:
          "text" in r
            ? r.text
            : `[resource ${r.uri}${r.mimeType !== undefined ? ` (${r.mimeType})` : ""}]`,
        ...po,
      };
    }
    default:
      // Safe degrade — text-ify any block without a native part rather than
      // dropping it (the no-silent-drop invariant; see content-blocks.ts).
      return {
        type: "text",
        text:
          "text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block),
      };
  }
}

export function imageUrlFromSource(source: MediaSource, mimeType: string | undefined): string {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64": {
      const mt = source.mimeType ?? mimeType ?? "image/png";
      return `data:${mt};base64,${source.data}`;
    }
    case "reference":
      return source.fileId;
    case "s3":
      return `s3://${source.bucket}/${source.key}`;
    case "gcs":
      return `gs://${source.bucket}/${source.object}`;
  }
}

/**
 * Project `ToolDeclaration[]` to the wire-shape `LanguageModelTool[]`.
 * Filters to model-exposed tools and projects `inputSchema` /
 * `outputSchema` through `toJsonSchema()` for the provider.
 *
 * Adopters: prefer the canonical `ProjectInput.tools` source rather
 * than re-reading `compiled.declarations.tools` — the IR slot is the
 * reconciler's record; the canonical source is the loop's compile
 * (which folds gateway/app/session/execution/extension/reconciler
 * with correct precedence). Provider-specific executors that need to
 * stay aligned with the canonical fold should call this helper.
 *
 * ## Model-call narration (`_summary`)
 *
 * When `narrate` is `true` (the default), each model-facing tool schema
 * gets an optional {@link TOOL_NARRATION_FIELD} (`_summary`) string
 * property injected so the model can self-narrate what a call is doing —
 * the sentence that lights the tool-start spinner. The tool executor
 * STRIPS it before validation, so it never reaches the handler. Injection
 * is skipped for a tool when `narrate` is `false` (app-level off-switch),
 * when the tool sets `annotations.narrate === false`, or when the tool's
 * own schema already declares a `_summary` property (implicit opt-out —
 * we never clobber an author field). `_summary` is NEVER added to
 * `required`. Token cost: one extra schema property per tool + one extra
 * model-emitted sentence per call — disable app-wide via `narrate: false`.
 */
export function buildTools(
  tools: readonly ToolDeclaration[],
  narrate = true,
): ReadonlyArray<LanguageModelTool> {
  return tools
    .filter((t) => t.exposure.includes("model"))
    .map((t) => ({
      name: t.name,
      ...omitUndefined({ description: t.description }),
      inputSchema: injectNarration(
        toJsonSchema(t.inputSchema) as Record<string, unknown>,
        narrate && t.annotations?.narrate !== false,
      ),
      ...(t.outputSchema !== undefined
        ? { outputSchema: toJsonSchema(t.outputSchema) as Record<string, unknown> }
        : {}),
      ...omitUndefined({ providerOptions: t.providerOptions }),
    }));
}

/**
 * Inject the reserved {@link TOOL_NARRATION_FIELD} into a tool's wire JSON
 * schema when narration is enabled for that tool. Never mutates the input
 * (`toJsonSchema` may return a cached raw-schema reference shared across
 * calls) — shallow-copies the schema and its `properties`. Skips injection
 * when the schema already declares `_summary` (implicit per-tool opt-out).
 * `_summary` is optional — never added to `required`.
 */
function injectNarration(
  schema: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return schema;
  const existing = (schema.properties as Record<string, unknown> | undefined) ?? undefined;
  if (existing && Object.prototype.hasOwnProperty.call(existing, TOOL_NARRATION_FIELD)) {
    // The author already owns `_summary` — leave their field intact.
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...existing,
      [TOOL_NARRATION_FIELD]: {
        type: "string",
        description:
          "One short first-person sentence describing what you're doing with this call, " +
          'shown to the user (e.g. "Searching the docs for retry config").',
      },
    },
  };
}
