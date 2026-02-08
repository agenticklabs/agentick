import type { COMInput, EphemeralEntry, EphemeralPosition } from "../../com/types";
import type {
  ContentBlock,
  Message,
  EventBlock,
  TextBlock,
  ToolResult,
  ToolCall,
} from "@agentick/shared";
import { isEventBlock, StopReason } from "@agentick/shared";
import type { EngineResponse } from "../../engine/engine-response";
import type { DelimiterConfig, EventBlockDelimiters } from "../../types";
import type { ModelConfig, ModelInput, ModelOutput, MessageTransformationConfig } from "../model";
import { Logger } from "@agentick/kernel";

const log = Logger.for("language-model");

function deriveStopReason(output: ModelOutput) {
  if (!output.stopReason) {
    return undefined;
  }

  return {
    reason: output.stopReason,
    description: `Stopped due to ${output.stopReason}`,
    recoverable: false,
    metadata: {
      usage: output.usage,
      model: output.model,
    },
  };
}

function isTerminalStopReason(reason: string | StopReason): boolean {
  const terminalReasons = [
    StopReason.STOP,
    StopReason.EXPLICIT_COMPLETION,
    StopReason.NATURAL_COMPLETION,
    StopReason.MAX_TOKENS,
    StopReason.CONTENT_FILTER,
  ];
  return terminalReasons.includes(reason as StopReason);
}

// ============================================================================
// Transformer Functions
// ============================================================================

/** Default message transformation config */
const DEFAULT_TRANSFORMATION_CONFIG: MessageTransformationConfig = {
  preferredRenderer: "markdown",
  roleMapping: {
    event: "user",
    ephemeral: "user",
  },
  delimiters: {
    event: "[Event]",
    ephemeral: "[Context]",
    useDelimiters: true,
  },
  ephemeralPosition: "flow",
};

/**
 * Resolve message transformation config from model capabilities and options.
 * Handles function-based configs that need model ID/provider to resolve.
 */
function resolveTransformationConfig(
  modelId: string,
  provider: string | undefined,
  modelCapabilities?: {
    messageTransformation?:
      | MessageTransformationConfig
      | ((modelId: string, provider?: string) => MessageTransformationConfig);
  },
  modelOptions?: ModelConfig,
  inputModelOptions?: ModelConfig,
): MessageTransformationConfig {
  // 1. Get base config from model capabilities (resolve function if needed)
  let baseConfig: MessageTransformationConfig | undefined;
  if (modelCapabilities?.messageTransformation) {
    const cap = modelCapabilities.messageTransformation;
    baseConfig = typeof cap === "function" ? cap(modelId, provider) : cap;
  }

  // 2. Merge with modelOptions.messageTransformation
  // 3. Merge with inputModelOptions.messageTransformation
  // 4. Apply defaults
  return {
    ...DEFAULT_TRANSFORMATION_CONFIG,
    ...baseConfig,
    ...modelOptions?.messageTransformation,
    ...inputModelOptions?.messageTransformation,
    roleMapping: {
      ...DEFAULT_TRANSFORMATION_CONFIG.roleMapping,
      ...baseConfig?.roleMapping,
      ...modelOptions?.messageTransformation?.roleMapping,
      ...inputModelOptions?.messageTransformation?.roleMapping,
    },
    delimiters: {
      ...DEFAULT_TRANSFORMATION_CONFIG.delimiters,
      ...baseConfig?.delimiters,
      ...modelOptions?.messageTransformation?.delimiters,
      ...inputModelOptions?.messageTransformation?.delimiters,
    },
  };
}

/**
 * Helper to check if delimiter config is per-block-type
 */
function isBlockDelimiters(
  delimiter: DelimiterConfig | EventBlockDelimiters | undefined,
): delimiter is EventBlockDelimiters {
  if (!delimiter || typeof delimiter === "string") return false;
  // Check if it has any of the block-type keys
  return (
    "user_action" in delimiter ||
    "system_event" in delimiter ||
    "state_change" in delimiter ||
    "default" in delimiter
  );
}

/**
 * Get delimiter for a specific block type
 */
function getDelimiterForBlock(
  blockType: string,
  delimiters: EventBlockDelimiters,
): DelimiterConfig | undefined {
  switch (blockType) {
    case "user_action":
      return delimiters.user_action ?? delimiters.default;
    case "system_event":
      return delimiters.system_event ?? delimiters.default;
    case "state_change":
      return delimiters.state_change ?? delimiters.default;
    default:
      return delimiters.default;
  }
}

/**
 * Wrap text with delimiter
 */
function wrapTextWithDelimiter(
  text: string,
  delimiter: DelimiterConfig | undefined,
): ContentBlock[] {
  if (!delimiter) {
    return [{ type: "text" as const, text }];
  }

  const result: ContentBlock[] = [];
  const startDelim = typeof delimiter === "string" ? delimiter : delimiter.start;
  const endDelim = typeof delimiter === "string" ? "" : delimiter.end;

  if (startDelim) {
    result.push({
      type: "text" as const,
      text: `${startDelim} ${text}${endDelim ? ` ${endDelim}` : ""}`,
    });
  } else {
    result.push({ type: "text" as const, text });
  }

  return result;
}

/**
 * Convert unsupported content blocks to text blocks for ModelInput.
 *
 * Models only support a subset of ContentBlock types natively:
 * - text, image, document, audio, video, tool_use, tool_result, reasoning
 *
 * Unsupported types must be converted to text:
 * - code → markdown code fences
 * - json → markdown JSON code fences
 * - Other convertible types → text representation
 *
 * This ensures ModelInput only contains ModelInputContentBlock types.
 *
 * @param blocks - Content blocks from COMInput (may include unsupported types)
 * @returns Content blocks suitable for ModelInput (only supported types)
 */
function convertUnsupportedBlocksToText(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.flatMap((block) => {
    // Code blocks → markdown code fences
    if (block.type === "code") {
      const codeBlock = block as any;
      const language = codeBlock.language || "";
      return [
        {
          type: "text" as const,
          text: `\`\`\`${language}\n${codeBlock.text}\n\`\`\``,
        },
      ];
    }

    // JSON blocks → markdown JSON code fences
    if (block.type === "json") {
      const jsonBlock = block as any;
      const jsonText = jsonBlock.text || JSON.stringify(jsonBlock.data || {}, null, 2);
      return [
        {
          type: "text" as const,
          text: `\`\`\`json\n${jsonText}\n\`\`\``,
        },
      ];
    }

    // Event blocks are handled separately by transformEventContent
    // Other unsupported types → convert to text representation
    // (xml, csv, html, generated_image, etc.)
    const unsupportedTypes = [
      "xml",
      "csv",
      "html",
      "generated_image",
      "generated_file",
      "executable_code",
      "code_execution_result",
    ];
    if (unsupportedTypes.includes(block.type)) {
      // Convert to text representation
      const text = (block as any).text || JSON.stringify(block, null, 2);
      return [
        {
          type: "text" as const,
          text,
        },
      ];
    }

    // Pass through supported block types unchanged
    // (text, image, document, audio, video, tool_use, tool_result, reasoning)
    return [block];
  });
}

/**
 * Extract text representation from an event block.
 * Uses the block's `text` field if available, otherwise generates from semantic fields.
 */
function getEventBlockText(block: ContentBlock): string {
  // Text blocks use their text directly
  if (block.type === "text") {
    return (block as TextBlock).text;
  }

  // Event blocks: use text field if available, else serialize semantic data
  const eventBlock = block as EventBlock;
  if ("text" in eventBlock && eventBlock.text) {
    return eventBlock.text;
  }

  // Fallback: generate text from semantic fields
  switch (block.type) {
    case "user_action": {
      const ua = block as any;
      const parts = [ua.actor || "User", ua.action];
      if (ua.target) parts.push(`on ${ua.target}`);
      return parts.join(" ");
    }
    case "system_event": {
      const se = block as any;
      const parts = [se.event];
      if (se.source) parts.push(`(${se.source})`);
      return parts.join(" ");
    }
    case "state_change": {
      const sc = block as any;
      return `${sc.entity}${sc.field ? `.${sc.field}` : ""}: ${JSON.stringify(sc.from)} → ${JSON.stringify(sc.to)}`;
    }
    default:
      return JSON.stringify(block);
  }
}

/**
 * Transform event message content based on unified config.
 *
 * Supports:
 * - Custom formatBlock function (full control)
 * - Per-block-type delimiters (uses block.text if available)
 * - Simple delimiter (wraps all content)
 *
 * Event blocks with `text` field use that for content; otherwise
 * a default representation is generated from semantic fields.
 *
 * Note: This is called AFTER StructureRenderer formats event blocks to text.
 * If content is already text blocks (formatted by renderer), delimiters are
 * only applied if useDelimiters is true. If content is still event blocks,
 * they are converted to text first, then delimiters are applied.
 */
function transformEventContent(
  content: ContentBlock[],
  config: MessageTransformationConfig,
): ContentBlock[] {
  // If custom formatter provided, use it for each block
  if (config.formatBlock) {
    return content.flatMap((block) => {
      if (isEventBlock(block) || block.type === "text") {
        return config.formatBlock!(block as EventBlock | TextBlock);
      }
      // Non-event blocks pass through
      return [block];
    });
  }

  // Check if delimiters should be used
  if (!config.delimiters?.useDelimiters) {
    return content;
  }

  const delimiter = config.delimiters.event;
  if (!delimiter) {
    return content;
  }

  // Check if content is already formatted text blocks (from renderer)
  // If so, we need to extract the text and wrap it with delimiters
  const _isAlreadyFormatted = content.every((block) => block.type === "text");

  // Per-block-type delimiters - extract text and wrap each block
  if (isBlockDelimiters(delimiter)) {
    const wrapped = content.flatMap((block) => {
      const blockText = getEventBlockText(block);
      // Skip empty text blocks
      if (!blockText || blockText.trim() === "") {
        return [];
      }
      const blockDelim = getDelimiterForBlock(block.type, delimiter);
      return wrapTextWithDelimiter(blockText, blockDelim);
    });
    // If all blocks were empty, return original content (don't add delimiters to empty content)
    return wrapped.length > 0 ? wrapped : content;
  }

  // Simple delimiter - combine all block texts and wrap
  const allText = content
    .map(getEventBlockText)
    .filter((text) => text && text.trim() !== "")
    .join("\n");
  if (!allText || allText.trim() === "") {
    // If no text content, return original content (don't add delimiters to empty content)
    return content;
  }
  return wrapTextWithDelimiter(allText, delimiter);
}

/**
 * Convert an EphemeralEntry to a Message with the configured role and formatting.
 *
 * Content is already consolidated by StructureRenderer - this just applies
 * delimiters and role mapping.
 *
 * @param entry - Ephemeral entry to convert
 * @param config - Unified transformation configuration
 */
function ephemeralEntryToMessage(
  entry: EphemeralEntry,
  config: MessageTransformationConfig,
): Message {
  // Build content with delimiters
  let content: ContentBlock[] = [...entry.content];

  // Apply delimiters if enabled
  if (config.delimiters?.useDelimiters && config.delimiters.ephemeral) {
    const delimiter = config.delimiters.ephemeral;
    const startDelim = typeof delimiter === "string" ? delimiter : delimiter.start;
    const endDelim = typeof delimiter === "string" ? "" : delimiter.end;

    // Prepend delimiter to first text block if possible, otherwise add as new block
    if (startDelim) {
      if (content.length > 0 && content[0].type === "text") {
        content[0] = {
          type: "text" as const,
          text: `${startDelim}\n${(content[0] as TextBlock).text}`,
        };
      } else {
        content.unshift({ type: "text" as const, text: startDelim });
      }
    }

    // Append delimiter to last text block if possible, otherwise add as new block
    if (endDelim) {
      const lastIdx = content.length - 1;
      if (lastIdx >= 0 && content[lastIdx].type === "text") {
        content[lastIdx] = {
          type: "text" as const,
          text: `${(content[lastIdx] as TextBlock).text}\n${endDelim}`,
        };
      } else {
        content.push({ type: "text" as const, text: endDelim });
      }
    }
  }

  // Convert unsupported blocks to text (models don't support code/json blocks natively)
  content = convertUnsupportedBlocksToText(content);

  const role = config.roleMapping?.ephemeral || "user";
  // Map 'developer' to 'user' for Message type (adapter will convert to 'developer' if supported)
  const messageRole: Message["role"] = role === "developer" ? "user" : (role as "user" | "system");
  return {
    role: messageRole,
    content,
  };
}

/**
 * Interleave ephemeral entries into the message array based on their position.
 *
 * Ephemeral entries are NOT Messages - they are transient content that gets
 * converted to Messages and inserted at the appropriate positions.
 *
 * Position semantics:
 * - 'flow': In declaration order (converted and appended to messages)
 * - 'after-system': Immediately after the last system message
 * - 'start': After system + after-system, before conversation
 * - 'before-user': Just before the last user message
 * - 'end': At the very end
 *
 * Entries with the same position are ordered by their `order` property (lower = earlier).
 *
 * @param messages - Timeline messages (persisted)
 * @param ephemeral - Ephemeral entries (transient)
 * @param config - Role and formatting configuration for conversion
 */
function interleaveEphemeral(
  messages: Message[],
  ephemeral: EphemeralEntry[],
  config: MessageTransformationConfig,
): Message[] {
  if (ephemeral.length === 0) {
    return messages;
  }

  // Group ephemeral entries by position
  const defaultPosition = config.ephemeralPosition || "flow";
  const positionBuckets: Record<EphemeralPosition, EphemeralEntry[]> = {
    flow: [],
    "after-system": [],
    start: [],
    "before-user": [],
    end: [],
  };

  for (const entry of ephemeral) {
    const entryPosition = entry.position || defaultPosition;
    const bucket = positionBuckets[entryPosition] || positionBuckets["end"];
    bucket.push(entry);
  }

  // Sort each bucket by order (lower = earlier)
  const sortByOrder = (a: EphemeralEntry, b: EphemeralEntry) => {
    return (a.order ?? 0) - (b.order ?? 0);
  };

  for (const bucket of Object.values(positionBuckets)) {
    bucket.sort(sortByOrder);
  }

  // Convert buckets to messages
  const toMessages = (entries: EphemeralEntry[]) =>
    entries.map((e) => ephemeralEntryToMessage(e, config));

  // If only flow entries, append them as messages
  const hasPositionedEntries =
    positionBuckets["after-system"].length > 0 ||
    positionBuckets["start"].length > 0 ||
    positionBuckets["before-user"].length > 0 ||
    positionBuckets["end"].length > 0;

  if (!hasPositionedEntries) {
    // Flow entries get appended at the end (they represent current state)
    return [...messages, ...toMessages(positionBuckets["flow"])];
  }

  // Find key positions in messages
  let lastSystemIdx = -1;
  let lastUserIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      lastSystemIdx = i;
    }
    if (messages[i].role === "user") {
      lastUserIdx = i;
    }
  }

  // Build result with ephemeral messages inserted at the right points
  const result: Message[] = [];

  let insertedAfterSystem = false;
  let insertedStart = false;
  let insertedBeforeUser = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Insert after-system after the last system message
    if (!insertedAfterSystem && lastSystemIdx >= 0 && i === lastSystemIdx) {
      result.push(msg);
      result.push(...toMessages(positionBuckets["after-system"]));
      insertedAfterSystem = true;

      // Also insert 'start' after system
      result.push(...toMessages(positionBuckets["start"]));
      insertedStart = true;
      continue;
    }

    // Insert start at beginning if no system messages
    if (!insertedStart && lastSystemIdx === -1 && i === 0) {
      result.push(...toMessages(positionBuckets["after-system"]));
      result.push(...toMessages(positionBuckets["start"]));
      insertedStart = true;
    }

    // Insert before-user before the last user message
    if (!insertedBeforeUser && lastUserIdx >= 0 && i === lastUserIdx) {
      result.push(...toMessages(positionBuckets["before-user"]));
      insertedBeforeUser = true;
    }

    result.push(msg);
  }

  // Handle edge cases - insert any positioned messages that weren't inserted
  if (!insertedAfterSystem) {
    result.unshift(...toMessages(positionBuckets["after-system"]));
  }
  if (!insertedStart) {
    const afterSystemCount = positionBuckets["after-system"].length;
    result.splice(afterSystemCount, 0, ...toMessages(positionBuckets["start"]));
  }
  if (!insertedBeforeUser && positionBuckets["before-user"].length > 0) {
    result.push(...toMessages(positionBuckets["before-user"]));
  }

  // Flow entries go before positioned 'end' entries
  result.push(...toMessages(positionBuckets["flow"]));

  // End always goes at the very end
  result.push(...toMessages(positionBuckets["end"]));

  return result;
}

/**
 * Convert COMInput to ModelInput
 *
 * @param input - COMInput from engine state
 * @param modelOptions - Optional model options to merge into ModelInput (can also be provided via input.modelOptions)
 * @param model - Optional model instance to get transformation config from capabilities
 * @returns ModelInput with modelOptions merged in
 */
export async function fromEngineState(
  input: COMInput,
  modelOptions?: ModelConfig,
  model?: {
    metadata: {
      id?: string;
      model?: string;
      provider?: string;
      capabilities?: {
        messageTransformation?:
          | MessageTransformationConfig
          | ((modelId: string, provider?: string) => MessageTransformationConfig);
      };
    };
  },
): Promise<ModelInput> {
  // Resolve transformation config from model capabilities and options
  const modelId = model?.metadata.id || model?.metadata.model || "";
  const provider = model?.metadata.provider;
  const transformationConfig = resolveTransformationConfig(
    modelId,
    provider,
    model?.metadata.capabilities,
    modelOptions,
    input.modelOptions,
  );

  // Extract conversation messages from timeline (excludes system - those are in input.system)
  log.debug({ timelineCount: input.timeline.length }, "fromEngineState processing timeline");
  input.timeline.forEach((entry, i) => {
    log.debug(
      { index: i, kind: entry.kind, role: entry.message?.role },
      "fromEngineState timeline entry",
    );
  });
  const timelineMessages: Message[] = input.timeline
    .filter((entry) => entry.kind === "message")
    .map((entry) => entry.message);
  log.debug(
    { timelineMessagesCount: timelineMessages.length },
    "fromEngineState extracted timeline messages",
  );

  // Transform event messages (models don't understand 'event' role)
  // Also convert code/json blocks to markdown text (models don't support code blocks natively)
  const conversationMessages = timelineMessages.map((msg) => {
    let content = msg.content;

    // Transform event messages
    if (msg.role === "event") {
      content = transformEventContent(content, transformationConfig);
      const eventRole = transformationConfig.roleMapping?.event || "user";
      // Map 'developer' to 'user' for Message type (adapter will convert to 'developer' if supported)
      const messageRole: Message["role"] =
        eventRole === "developer"
          ? "user"
          : eventRole === "event"
            ? "user"
            : (eventRole as "user" | "system");
      return {
        ...msg,
        role: messageRole,
        content: convertUnsupportedBlocksToText(content),
      };
    }

    // Convert unsupported blocks to text for all messages (code/json blocks → markdown)
    return {
      ...msg,
      content: convertUnsupportedBlocksToText(content),
    };
  });

  // Build base message array: system messages FIRST, then conversation
  const baseMessages: Message[] = [];

  // System messages come from input.system (rebuilt fresh each tick by StructureRenderer)
  // Unwrap from COMTimelineEntry envelope and convert unsupported blocks to text
  if (input.system && input.system.length > 0) {
    const systemMessages = input.system
      .filter((entry) => entry.kind === "message")
      .map((entry) => ({
        ...entry.message,
        content: convertUnsupportedBlocksToText(entry.message.content),
      }));
    baseMessages.push(...systemMessages);
  } else {
    // No system message exists - create one from sections (fallback for direct model calls)
    const systemSections = Object.values(input.sections)
      .filter((s) => s.audience === "model")
      .map((s) => {
        // Use formattedContent if available (already processed ContentBlocks)
        const contentToUse = s.formattedContent ?? s.content;

        if (typeof contentToUse === "string") {
          return s.title ? `${s.title}: ${contentToUse}` : contentToUse;
        }

        // If it's an array of content blocks, extract text
        if (Array.isArray(contentToUse)) {
          const text = contentToUse
            .map((block) => {
              if (typeof block === "string") return block;
              if (block && typeof block === "object" && "text" in block) {
                return (block as { text: string }).text;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n");
          return s.title ? `${s.title}: ${text}` : text;
        }

        // Fallback for other types
        return s.title ? `${s.title}: ${String(contentToUse)}` : String(contentToUse);
      });

    if (systemSections.length > 0) {
      baseMessages.push({
        role: "system",
        content: [{ type: "text", text: systemSections.join("\n\n") }],
      });
    }
  }

  // Add conversation messages after system
  baseMessages.push(...conversationMessages);

  // NOW interleave ephemeral entries into the correctly-ordered message array
  // This happens AFTER system consolidation so positions are respected
  const messages = interleaveEphemeral(baseMessages, input.ephemeral || [], transformationConfig);

  // Convert tools to ModelInput format
  const tools = input.tools || [];

  // Build base ModelInput
  const baseModelInput: ModelInput = {
    messages,
    tools: tools.length > 0 ? tools : [],
  };

  // Merge modelOptions from input.modelOptions or passed parameter
  const optionsToMerge = modelOptions || input.modelOptions;
  if (optionsToMerge) {
    // Merge modelOptions into ModelInput
    // Only include defined values
    if (optionsToMerge.model !== undefined) {
      baseModelInput.model = optionsToMerge.model;
    }
    if (optionsToMerge.temperature !== undefined) {
      baseModelInput.temperature = optionsToMerge.temperature;
    }
    if (optionsToMerge.maxTokens !== undefined) {
      baseModelInput.maxTokens = optionsToMerge.maxTokens;
    }
    if (optionsToMerge.topP !== undefined) {
      baseModelInput.topP = optionsToMerge.topP;
    }
    if (optionsToMerge.frequencyPenalty !== undefined) {
      baseModelInput.frequencyPenalty = optionsToMerge.frequencyPenalty;
    }
    if (optionsToMerge.presencePenalty !== undefined) {
      baseModelInput.presencePenalty = optionsToMerge.presencePenalty;
    }
    if (optionsToMerge.stop !== undefined) {
      baseModelInput.stop = optionsToMerge.stop;
    }
    if (optionsToMerge.providerOptions !== undefined) {
      baseModelInput.providerOptions = optionsToMerge.providerOptions;
    }
    if (optionsToMerge.responseFormat !== undefined) {
      baseModelInput.responseFormat = optionsToMerge.responseFormat;
    }
    // Note: tools from modelOptions are not merged - we use tools from COMInput.tools
  }

  return baseModelInput;
}

/**
 * Extract tool calls and results from messages, separating pending from executed.
 *
 * Provider/adapter-executed tools will have both tool_use and tool_result messages.
 * Pending tools will only have tool_use without corresponding tool_result.
 */
function extractToolCallsAndResults(messages: Message[]): {
  pendingToolCalls: ToolCall[];
  executedToolResults: ToolResult[];
} {
  // First pass: collect all toolUseIds that have tool_result messages
  const executedToolIds = new Set<string>();
  const executedResults: ToolResult[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const toolResultBlock = block as ContentBlock & {
            toolUseId: string;
            name?: string;
            content?: ContentBlock[];
            isError?: boolean;
          };
          executedToolIds.add(toolResultBlock.toolUseId);
          executedResults.push({
            id: toolResultBlock.id,
            toolUseId: toolResultBlock.toolUseId,
            name: toolResultBlock.name || "unknown",
            content: toolResultBlock.content || [],
            success: !toolResultBlock.isError,
            executedBy: "adapter", // or 'provider' - could be refined based on metadata
          });
        }
      }
    }
  }

  // Second pass: collect tool_use blocks that weren't executed
  const pendingToolCalls: ToolCall[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const toolUseBlock = block as ContentBlock & {
            id?: string;
            toolUseId?: string;
            name: string;
            input: unknown;
          };
          // Support both `toolUseId` (standard) and `id` (some providers)
          const toolId = toolUseBlock.toolUseId || toolUseBlock.id || "";

          // Only include if not already executed
          if (!executedToolIds.has(toolId)) {
            pendingToolCalls.push({
              id: toolId,
              name: toolUseBlock.name,
              input: (toolUseBlock.input as Record<string, unknown>) || {},
            });
          }
        }
      }
    }
  }

  return { pendingToolCalls, executedToolResults: executedResults };
}

/**
 * Convert ModelOutput to EngineResponse
 */
export async function toEngineState(output: ModelOutput): Promise<EngineResponse> {
  // Derive structured stop reason information
  const stopReasonInfo = deriveStopReason(output);

  // Use messages array if available, fall back to single message
  const messages = output.messages?.length
    ? output.messages
    : output.message
      ? [output.message]
      : [];

  // Extract tool calls and results, separating pending from executed
  const { pendingToolCalls, executedToolResults } = extractToolCallsAndResults(messages);

  // Also check output.toolCalls for backward compatibility
  // These would be from adapters that don't use messages array
  const legacyToolCalls =
    output.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })) || [];

  // Merge: pendingToolCalls from messages + legacy toolCalls (dedupe by id)
  const seenIds = new Set(pendingToolCalls.map((tc) => tc.id));
  const allPendingToolCalls = [
    ...pendingToolCalls,
    ...legacyToolCalls.filter((tc) => !seenIds.has(tc.id)),
  ];

  // Determine if we should stop:
  // 1. No tool calls AND terminal stop reason, OR
  // 2. No tool calls AND empty content (model has nothing to say)
  const hasToolCalls = allPendingToolCalls.length > 0;
  const hasContent = messages.some(
    (msg) =>
      msg.role !== "tool" && msg.content && Array.isArray(msg.content) && msg.content.length > 0,
  );
  const isTerminal = stopReasonInfo ? isTerminalStopReason(stopReasonInfo.reason) : false;

  // Stop if: no tool calls AND (terminal stop reason OR empty response)
  // This prevents infinite loops when model returns empty content with UNSPECIFIED stop reason
  const shouldStop = !hasToolCalls && (isTerminal || !hasContent);

  return {
    newTimelineEntries: messages
      .filter((msg) => msg.role !== "tool") // Tool messages handled separately
      .map((msg) => ({
        kind: "message" as const,
        message: msg,
        tags: ["model_output"],
      })),
    toolCalls: allPendingToolCalls.length > 0 ? allPendingToolCalls : undefined,
    executedToolResults: executedToolResults.length > 0 ? executedToolResults : undefined,
    usage: output.usage,
    shouldStop,
    stopReason: stopReasonInfo,
  };
}
