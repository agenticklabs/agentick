import { Text } from "ink";
import { useStatusBarData } from "../context.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface TokenCountProps {
  /** Override token count */
  tokens?: number;
  /** Show cumulative usage across ticks (default: true) */
  cumulative?: boolean;
  /** Prefix label (e.g. "tokens:") */
  label?: string;
  color?: string;
}

export function TokenCount({ tokens, cumulative = true, label, color = "gray" }: TokenCountProps) {
  const data = useStatusBarData();
  const ci = data?.contextInfo;

  let count: number;
  if (tokens != null) {
    count = tokens;
  } else if (cumulative && ci?.cumulativeUsage) {
    count = ci.cumulativeUsage.totalTokens;
  } else {
    count = ci?.totalTokens ?? 0;
  }

  if (count === 0) return null;

  return (
    <Text color={color}>
      {label ? `${label} ` : ""}
      {formatTokens(count)}
    </Text>
  );
}
