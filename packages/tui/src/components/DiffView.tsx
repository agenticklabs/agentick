/**
 * DiffView — renders a unified diff with colored additions/removals.
 *
 * Parses a unified diff string (from jsdiff's createTwoFilesPatch)
 * and renders each line with appropriate coloring:
 * - Additions (+) in green
 * - Removals (-) in red
 * - Hunk headers (@@) in cyan
 * - Context lines dimmed
 */

import { Box, Text } from "ink";

interface DiffViewProps {
  patch: string;
  filePath?: string;
  maxLines?: number;
}

export function DiffView({ patch, filePath, maxLines = 80 }: DiffViewProps) {
  const lines = patch.split("\n");

  // Skip the header lines (--- and +++ and Index/diff)
  const contentLines = lines.filter(
    (line) => !line.startsWith("Index:") && !line.startsWith("diff ") && !line.startsWith("==="),
  );

  const displayLines = contentLines.slice(0, maxLines);
  const remaining = contentLines.length - maxLines;

  return (
    <Box flexDirection="column">
      {filePath && (
        <Text bold color="white">
          {filePath}
        </Text>
      )}
      {displayLines.map((line, i) => {
        if (line.startsWith("---") || line.startsWith("+++")) {
          return (
            <Text key={i} bold dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={i} color="cyan">
              {line}
            </Text>
          );
        }
        if (line.startsWith("+")) {
          return (
            <Text key={i} color="green">
              {line}
            </Text>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Text key={i} color="red">
              {line}
            </Text>
          );
        }
        return (
          <Text key={i} dimColor>
            {line}
          </Text>
        );
      })}
      {remaining > 0 && <Text dimColor>... {remaining} more line(s)</Text>}
    </Box>
  );
}
