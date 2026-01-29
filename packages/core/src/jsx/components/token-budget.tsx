import { createElement, type JSX } from "../jsx-runtime";
import { type ComponentBaseProps } from "../jsx-types";
import { createPolicy } from "../../state/boundary";
import type { COMTimelineEntry } from "../../com/types";

/**
 * Strategy for handling token budget overflow.
 *
 * - `truncate`: Remove oldest entries until within budget
 * - `drop-oldest`: Drop oldest entries (preserving system messages)
 * - `summarize`: Summarize old entries (requires summarizer function)
 */
export type TokenBudgetStrategy = "truncate" | "drop-oldest" | "summarize";

/**
 * Props for the TokenBudget component.
 */
export interface TokenBudgetProps {
  /** Maximum tokens allowed in the timeline */
  maxTokens: number;

  /** Strategy for handling overflow */
  strategy: TokenBudgetStrategy;

  /**
   * Roles to preserve when dropping entries.
   * Default: ['system'] - system messages are never dropped.
   */
  preserveRoles?: Array<"user" | "assistant" | "system" | "tool">;

  /**
   * Custom summarizer function for 'summarize' strategy.
   * Takes entries and target tokens, returns summarized entries.
   */
  summarizer?: (entries: COMTimelineEntry[], targetTokens: number) => Promise<COMTimelineEntry[]>;
}

/**
 * Estimate token count for a timeline entry.
 * Uses a simple heuristic: ~4 characters per token.
 */
function estimateTokens(entry: COMTimelineEntry): number {
  const content = entry.message.content;
  let textLength = 0;

  for (const block of content) {
    if (block.type === "text" && "text" in block) {
      textLength += (block as { type: "text"; text: string }).text.length;
    } else if (block.type === "code" && "text" in block) {
      textLength += (block as { type: "code"; text: string }).text.length;
    } else if (block.type === "tool_result" && "content" in block) {
      // Tool results can have nested content
      const toolContent = (block as any).content;
      if (typeof toolContent === "string") {
        textLength += toolContent.length;
      } else if (Array.isArray(toolContent)) {
        for (const c of toolContent) {
          if (c.type === "text" && c.text) {
            textLength += c.text.length;
          }
        }
      }
    }
  }

  // Rough estimate: 4 characters per token
  return Math.ceil(textLength / 4);
}

/**
 * Process entries with token budget policy.
 */
async function processTokenBudget(
  entries: COMTimelineEntry[],
  props: TokenBudgetProps,
): Promise<COMTimelineEntry[]> {
  const { maxTokens, strategy, preserveRoles = ["system"], summarizer } = props;

  // Calculate total tokens
  let totalTokens = 0;
  const entryTokens = entries.map((entry) => {
    const tokens = estimateTokens(entry);
    totalTokens += tokens;
    return { entry, tokens };
  });

  // If within budget, return as-is
  if (totalTokens <= maxTokens) {
    return entries;
  }

  // Apply strategy
  switch (strategy) {
    case "drop-oldest": {
      // Sort entries: preserved roles first, then by recency (newest first)
      const sorted = [...entryTokens].sort((a, b) => {
        const aPreserved = preserveRoles.includes(a.entry.message.role as any);
        const bPreserved = preserveRoles.includes(b.entry.message.role as any);
        if (aPreserved !== bPreserved) return aPreserved ? -1 : 1;
        // Newest first (higher index = newer)
        return entries.indexOf(b.entry) - entries.indexOf(a.entry);
      });

      // Keep entries until budget is full
      let budget = maxTokens;
      const kept = new Set<COMTimelineEntry>();
      for (const { entry, tokens } of sorted) {
        if (budget >= tokens) {
          kept.add(entry);
          budget -= tokens;
        }
      }

      // Return entries in original order
      return entries.filter((e) => kept.has(e));
    }

    case "truncate": {
      // Keep newest entries until budget is full
      let budget = maxTokens;
      const result: COMTimelineEntry[] = [];

      // Iterate from newest to oldest
      for (let i = entryTokens.length - 1; i >= 0; i--) {
        const { entry, tokens } = entryTokens[i];
        if (budget >= tokens) {
          result.unshift(entry);
          budget -= tokens;
        }
      }

      return result;
    }

    case "summarize": {
      if (!summarizer) {
        throw new Error("TokenBudget 'summarize' strategy requires a summarizer function");
      }
      return summarizer(entries, maxTokens);
    }

    default:
      return entries;
  }
}

/**
 * TokenBudget policy created with createPolicy.
 *
 * This uses the auto-accumulating pattern - nested TokenBudget components
 * will have their policies combined with parent policies.
 *
 * Use `useTokenBudget()` to read the current token budget settings during render.
 * Use `useBoundary(PolicyBoundary)` to get ALL active policies in scope.
 */
const tokenBudgetPolicy = createPolicy<TokenBudgetProps>("TokenBudget", processTokenBudget);

/**
 * TokenBudget component.
 *
 * Limits the total tokens in timeline entries within its scope.
 * Applies token budget processing during formatInput phase.
 *
 * **Auto-accumulation:** When TokenBudget is nested, ALL token budgets
 * apply to entries within their combined scope (outer first).
 *
 * @example Basic usage
 * ```tsx
 * <TokenBudget maxTokens={4000} strategy="drop-oldest">
 *   <Timeline />
 * </TokenBudget>
 * ```
 *
 * @example With custom preserved roles
 * ```tsx
 * <TokenBudget
 *   maxTokens={8000}
 *   strategy="drop-oldest"
 *   preserveRoles={['system', 'user']}
 * >
 *   <Timeline />
 * </TokenBudget>
 * ```
 *
 * @example Using summarize strategy
 * ```tsx
 * <TokenBudget
 *   maxTokens={4000}
 *   strategy="summarize"
 *   summarizer={async (entries, targetTokens) => {
 *     // Custom summarization logic
 *     return summarizedEntries;
 *   }}
 * >
 *   <Timeline />
 * </TokenBudget>
 * ```
 */
export interface TokenBudgetComponentProps extends TokenBudgetProps, ComponentBaseProps {
  children?: any;
}

export function TokenBudget(props: TokenBudgetComponentProps): JSX.Element {
  const { children, ...budgetProps } = props;
  return createElement(tokenBudgetPolicy.Provider, {
    value: budgetProps,
    children,
  });
}

/**
 * Hook to read the current token budget settings.
 *
 * @example
 * ```tsx
 * function TokenCounter() {
 *   const budget = useTokenBudget();
 *   if (!budget) return null;
 *   return <System>Token budget: {budget.maxTokens}</System>;
 * }
 * ```
 */
export function useTokenBudget(): TokenBudgetProps | null {
  return tokenBudgetPolicy.usePolicy();
}

/**
 * Export the policy for advanced usage.
 * @internal
 */
export { tokenBudgetPolicy as TokenBudgetPolicy };
