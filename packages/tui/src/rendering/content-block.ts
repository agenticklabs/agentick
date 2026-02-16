/**
 * Per-type content block rendering for terminal output.
 *
 * Each block type gets a dedicated renderer that returns ANSI-styled strings.
 * Used by renderMessage() to compose full message output.
 */

import type { ContentBlock } from "@agentick/shared";
import { theme, formatDuration } from "./theme.js";
import { renderMarkdown } from "./markdown.js";

/** Render a single content block to an ANSI string. */
export function renderContentBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return renderMarkdown(block.text);

    case "reasoning":
      if (block.isRedacted) return null;
      return theme.reasoning(block.text);

    case "tool_use":
      // Tool calls are rendered separately with duration info
      return null;

    case "tool_result": {
      if (!block.content || block.content.length === 0) return null;
      const inner = block.content
        .map((b) => renderContentBlock(b as ContentBlock))
        .filter(Boolean)
        .join("\n");
      if (!inner) return null;
      if (block.isError) {
        return `${theme.errorLabel("error")} ${theme.error(inner)}`;
      }
      return inner;
    }

    case "code":
      return renderMarkdown(`\`\`\`${block.language}\n${block.text}\n\`\`\``);

    case "executable_code":
      return renderMarkdown(`\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``);

    case "code_execution_result":
      if (block.isError) {
        return `${theme.errorLabel("error")} ${theme.error(block.output)}`;
      }
      return theme.dim(block.output);

    case "json":
      if (block.data !== undefined) {
        return renderMarkdown(`\`\`\`json\n${JSON.stringify(block.data, null, 2)}\n\`\`\``);
      }
      return renderMarkdown(`\`\`\`json\n${block.text}\n\`\`\``);

    case "xml":
      return renderMarkdown(`\`\`\`xml\n${block.text}\n\`\`\``);

    case "csv":
      return theme.dim(block.text);

    case "html":
      return theme.dim(block.text);

    case "image":
      return theme.dim(`[image${block.altText ? `: ${block.altText}` : ""}]`);

    case "document":
      return theme.dim(`[document${block.title ? `: ${block.title}` : ""}]`);

    case "audio":
      return theme.dim(`[audio${block.transcript ? `: ${block.transcript.slice(0, 80)}` : ""}]`);

    case "video":
      return theme.dim(`[video${block.transcript ? `: ${block.transcript.slice(0, 80)}` : ""}]`);

    case "generated_image":
      return theme.dim(`[generated image${block.altText ? `: ${block.altText}` : ""}]`);

    case "generated_file":
      return theme.dim(`[file: ${block.displayName ?? block.uri}]`);

    case "user_action":
      return block.text ?? theme.dim(`[action: ${block.action}]`);

    case "system_event":
      return block.text ?? theme.dim(`[event: ${block.event}]`);

    case "state_change":
      return block.text ?? theme.dim(`[state: ${block.entity}]`);

    default:
      return theme.dim(`[${(block as any).type}]`);
  }
}

/** Render a tool call indicator line. */
export function renderToolCall(name: string, duration?: number, summary?: string): string {
  const dur = duration != null ? ` ${theme.toolDuration(`(${formatDuration(duration)})`)}` : "";
  const sum = summary ? ` ${theme.dim(summary)}` : "";
  return `  ${theme.toolSymbol("+")} ${theme.toolName(name)}${sum}${dur}`;
}
