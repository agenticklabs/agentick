/**
 * Canonical `ProjectInput → LanguageModelInput` projection.
 *
 * Used as the default by `BaseLanguageModelExecutor.projectImpl` and by
 * `defineExecutor`'s `CallbackLanguageModelExecutor`. Concrete provider
 * executors override `projectImpl` only when their wire shape genuinely
 * differs — per-section cache breakpoints no longer require one, because a
 * section is a BLOCK now and a block is a part (ADR 94).
 *
 * The fold:
 *   - `system` entries → merged, in order, into ONE leading system message.
 *   - every other entry → a chat message at its own position, semantic role
 *     intact. Adapters lower `grounding` / `event` to provider vocabulary.
 *   - `tool` declarations with `model` exposure → `tools[]`.
 *
 * What it deliberately does NOT do is move anything. The IR is
 * position-faithful and so is this: an entry's index in
 * `tree.context.entries` is its index in `messages`, system aside.
 *
 * Pure / deterministic. No provider dependencies.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import type {
  ContentBlock,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelMessageRole,
  LanguageModelParameters,
  LanguageModelTool,
  MessageRole,
  ProjectInput,
  ProviderToolDeclaration,
  ProviderToolWire,
  RenderedTree,
  ToolDeclaration,
} from "@agentick/spec";
import { mergeProviderOptions, TOOL_NARRATION_FIELD, toJsonSchema } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

// Media is NOT screened here. `applyMediaSupport` runs one level up, in the
// executor's `projectImpl`, because an adapter may replace this whole function
// with its own `project` — and a screen that a custom projection can skip is the
// same "trust every adapter" problem the declaration exists to remove.
export function defaultProject(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  // Tools come from `input.tools` — the loop's per-tick compile result
  // (precedence-resolved across gateway/app/session/execution/extension/
  // compiler). The IR's `compiled.declarations.tools` records what
  // the compiler emitted but is NOT the canonical source for the
  // model's visible tool list. See `ProjectInput.tools` for context.
  const tools = buildTools(input.tools, input.narrate);
  // Provider-EXECUTED tools (Pass D). Sourced from `input.providerTools`
  // (the loop threads the compiled tree's `declarations.providerTools`
  // here) — NOT from `input.tools`. Provider tools bypass the executor:
  // they carry no schema, are never narrated (`injectNarration` never
  // sees them), and never join the function `tools` list.
  const providerTools = buildProviderTools(input.providerTools);
  const parameters = buildParameters(input.compiled);
  // #176: fold `tree.providerOptions` OVER `target.providerOptions`
  // (tree/per-render wins) onto the request-level channel. Previously
  // orphaned — the compiler collected `<ProviderOptions>` into
  // `RenderedTree.providerOptions` but nothing threaded it into the
  // executor input; adapters saw only `target.providerOptions`.
  const providerOptions = mergeProviderOptions(
    input.target.providerOptions,
    input.compiled.providerOptions,
  );
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...omitUndefined({ providerTools, parameters, providerOptions }),
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
    toolChoice?: "auto" | "none" | "required" | { tool: string };
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
  if (cfg.toolChoice !== undefined) {
    params.toolChoice =
      typeof cfg.toolChoice === "string" ? cfg.toolChoice : { tool: cfg.toolChoice.tool };
  }
  return Object.keys(params).length > 0 ? (params as LanguageModelParameters) : undefined;
}

export function buildMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  // Two accumulators, one pass. `system` has no position at the wire — two
  // of three providers take it as a separate request parameter — so system
  // entries merge, in tree order, into one leading message. Everything else
  // keeps its index. A `<System>` that is not leading is a COMPILE
  // diagnostic (`MID_STREAM_SYSTEM`); the projection still has one path,
  // because inventing a second one would mean inventing a mid-stream system
  // position no provider has.
  const systemParts: LanguageModelMessagePart[] = [];
  const rest: LanguageModelMessage[] = [];

  for (const entry of tree.context.entries) {
    const parts = joinTextParts(entry.content.map(messagePartFromBlock));
    const cache = entry.metadata?.cache;
    // Message-level `providerMetadata` (adopter-stamped input knobs) rides
    // the INPUT channel `providerOptions` at the wire boundary — same
    // send/return split as per-block `providerMetadata` → part
    // `providerOptions` (#173, ADR 57 §2).
    const providerOptions = entry.metadata?.providerMetadata;

    if (entry.role === "system") {
      // A message-level hint marks the LAST part it covers, matching how a
      // provider breakpoint caches the prefix through that block.
      for (const [i, part] of parts.entries()) {
        const marks = cache !== undefined && i === parts.length - 1 && part.type === "text";
        systemParts.push(marks ? { ...part, cache } : part);
      }
      continue;
    }

    rest.push({
      role: canonicalRole(entry.role),
      content: parts,
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      ...(cache !== undefined ? { cache } : {}),
    });
  }

  const messages: LanguageModelMessage[] = [];
  if (systemParts.length > 0) messages.push({ role: "system", content: systemParts });
  messages.push(...rest);
  return messages;
}

/**
 * Adjacent TEXT parts of ONE message join into one part, separated by a blank
 * line — unless a part carries a hint, which is a boundary.
 *
 * This is a TRANSPORT rule, which is why it lives here and not in the
 * formatter. A provider is free to concatenate a message's text parts with no
 * separator of its own, so `# A\nfirst` followed by `# B\nsecond` arrives as
 * `# A\nfirst# B\nsecond` — B's heading welded onto A's last line. The join
 * used to be applied by the formatter pass, to the two blocks that happened to
 * be adjacent SECTIONS; nothing about the defect was specific to sections, and
 * a text run followed by a fenced code block ran together exactly the same
 * way. One level down it covers every case, and it agrees with the string exit
 * by construction: `blocksToText` has always joined blocks with `\n\n`.
 *
 * **A hint IS a boundary** — the #185 rule, restated one more level down where
 * it always belonged. A part carrying `cache` marks a prompt-cache breakpoint
 * at a position in the prompt text; a part carrying `providerOptions` /
 * `providerMetadata` carries per-part provider knobs. Both are properties OF A
 * PART, so joining that part into its neighbour would move the breakpoint or
 * silently widen the knob's reach. Such a part neither absorbs nor is
 * absorbed.
 *
 * Exported because {@link import("./provenance.js").buildMessageProvenance}
 * must emit exactly one origin per PROJECTED part; re-deriving this rule there
 * is how the two walks drift.
 */
export function joinTextParts(
  parts: readonly LanguageModelMessagePart[],
): readonly LanguageModelMessagePart[] {
  const runs = textRuns(parts);
  if (runs.length === parts.length) return parts;
  return runs.map((run) =>
    run.length === 1
      ? parts[run[0]!]!
      : { ...parts[run[0]!]!, text: run.map((i) => textOf(parts[i]!)).join("\n\n") },
  );
}

/**
 * The block indices that make up each projected part: `[[0],[1]]` when nothing
 * joins, `[[0,1]]` when the first two do. The grouping, without the joining —
 * so the provenance walk can name the block each projected part STARTS at
 * without rebuilding the parts.
 */
export function textRuns(parts: readonly LanguageModelMessagePart[]): readonly number[][] {
  const runs: number[][] = [];
  for (const [i, part] of parts.entries()) {
    const open = runs[runs.length - 1];
    if (open !== undefined && joinable(parts[open[open.length - 1]!]!) && joinable(part)) {
      open.push(i);
    } else {
      runs.push([i]);
    }
  }
  return runs;
}

function joinable(part: LanguageModelMessagePart): boolean {
  return (
    part.type === "text" &&
    part.cache === undefined &&
    part.providerOptions === undefined &&
    part.providerMetadata === undefined
  );
}

function textOf(part: LanguageModelMessagePart): string {
  return part.type === "text" ? part.text : "";
}

/** The closed provider-facing role vocabulary, as a runtime set. */
const CANONICAL_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "tool",
  "grounding",
  "event",
]);

/**
 * Thrown when a message carries a role no consumer downstream can act on.
 *
 * `MessageRole` is an open string so an application can tag its own turns;
 * `LanguageModelMessageRole` is closed because a provider request has a
 * fixed set of slots. This is the one place the two meet, and it used to be
 * an unchecked `entry.role as LanguageModelMessage["role"]` — which sent
 * `role: "event"` to providers that have no such role and let a typo reach
 * the wire as a 400 with no local explanation.
 */
export class UnknownMessageRoleError extends Error {
  constructor(readonly role: string) {
    super(
      `Unknown message role ${JSON.stringify(role)}. A projected message must carry one of: ` +
        `${[...CANONICAL_ROLES].join(", ")}. Agentick-semantic roles are lowered to provider ` +
        `vocabulary by the adapter — add the role there rather than casting it here.`,
    );
    this.name = "UnknownMessageRoleError";
  }
}

/**
 * Narrow an open {@link MessageRole} to the closed projection vocabulary.
 * Replaces the cast; an unrecognized role is an error, never a coercion.
 */
export function canonicalRole(role: MessageRole): LanguageModelMessageRole {
  if (!CANONICAL_ROLES.has(role)) throw new UnknownMessageRoleError(role);
  return role as LanguageModelMessageRole;
}

/**
 * Lower an agentick-semantic role to ONE provider's role vocabulary.
 *
 * The split is architectural: the canonical fold keeps `grounding` and
 * `event` intact (they are meaningful to the framework and to any adapter
 * that has a slot for them), and each adapter collapses them at its own
 * boundary — OpenAI has `developer` for non-user instructions, Anthropic and
 * Google do not and take `user`. Wire constraints live at the wire.
 *
 * The table is total over the role union, so a role added to the union
 * breaks every adapter at COMPILE time instead of silently defaulting.
 */
export function lowerSemanticRole<R extends string>(
  role: LanguageModelMessageRole,
  table: Readonly<Record<LanguageModelMessageRole, R>>,
): R {
  const lowered = table[role];
  // Reachable only from data that entered through a cast — worth the branch,
  // because the alternative is `undefined` on the wire.
  if (lowered === undefined) throw new UnknownMessageRoleError(role);
  return lowered;
}

export function messagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  const part = projectBlock(block);
  // A block-level cache breakpoint reaches the part unchanged. This is what
  // keeps a `<Section cache={...}>` a real boundary after ADR 94 dissolved
  // section entries into message content (#185). Only the TEXT part carries
  // a hint — the breakpoint is a position in the prompt text, and no
  // provider marks a cache boundary on a media part.
  return block.cache !== undefined && part.type === "text" ? { ...part, cache: block.cache } : part;
}

function projectBlock(block: ContentBlock): LanguageModelMessagePart {
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
        source: block.source,
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
      return { type: "reasoning", text: block.text, ...po };
    case "generated_image":
      // Replayed as input → reuse the `image` variant (ADR 57
      // §Taxonomy). Emit a data URI, NOT `JSON.stringify(block)` — the
      // latter dumped the entire base64 payload into a text token-bomb.
      return {
        type: "image",
        source: {
          type: "base64",
          data: block.data,
          ...omitUndefined({ mimeType: block.mimeType }),
        },
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

/**
 * Project `ToolDeclaration[]` to the wire-shape `LanguageModelTool[]`.
 * Filters to model-exposed tools and projects `inputSchema` /
 * `outputSchema` through `toJsonSchema()` for the provider.
 *
 * Adopters: prefer the canonical `ProjectInput.tools` source rather
 * than re-reading `compiled.declarations.tools` — the IR slot is the
 * compiler's record; the canonical source is the loop's compile
 * (which folds gateway/app/session/execution/extension/compiler
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
 * Project `ProviderToolDeclaration[]` to the wire-shape
 * {@link ProviderToolWire}[] for provider-EXECUTED tools (OpenAI
 * `web_search`, Anthropic `server_tool_use`, Google grounding). These are
 * a SIBLING of the function `tools` list — they bypass the tool executor
 * entirely, so this projection is deliberately minimal: it resolves
 * `name: decl.name ?? decl.type`, copies `provider` / `type` / `config`
 * verbatim, and does NOTHING else — no schema projection (the provider owns
 * the arguments), no `injectNarration` (provider tools are never narrated).
 *
 * Dedupe is by `provider` + resolved `name`, LAST-WINS — matching the flat,
 * ladder-free merge documented on
 * {@link import("@agentick/spec").RuntimeDeclarations.providerTools}
 * (a provider tool has no layered identity, so there is no precedence fold
 * like `buildTools`' exposure/collision handling). Returns `undefined` when
 * the input is absent or projects to empty, so `defaultProject`'s
 * `omitUndefined({...})` spread drops the slot entirely rather than emitting
 * an empty array.
 *
 * @verifiedBy packages/model/src/__tests__/canonical-projection.spec.ts
 *   ("defaultProject — Pass D providerTools projection")
 */
export function buildProviderTools(
  providerTools?: readonly ProviderToolDeclaration[],
): ReadonlyArray<ProviderToolWire> | undefined {
  if (providerTools === undefined || providerTools.length === 0) return undefined;
  // Dedupe by `provider` + resolved `name`, last-wins: a later declaration
  // with the same key replaces an earlier one. A Map preserves first-seen
  // insertion order for surviving keys while letting a later value win.
  const byKey = new Map<string, ProviderToolWire>();
  for (const decl of providerTools) {
    const name = decl.name ?? decl.type;
    // `\0` is a deliberate key separator — a provider or tool name cannot
    // contain it, so no two distinct pairs can collide on the joined key.
    // Written as an ESCAPE: a raw NUL byte in the source makes `file`
    // classify this module as binary and makes plain `grep` skip it whole.
    byKey.set(`${decl.provider}\0${name}`, {
      provider: decl.provider,
      type: decl.type,
      name,
      ...omitUndefined({ config: decl.config }),
    });
  }
  const wire = [...byKey.values()];
  return wire.length > 0 ? wire : undefined;
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
        description: "One short first-person sentence describing this call, shown to the user.",
      },
    },
  };
}
