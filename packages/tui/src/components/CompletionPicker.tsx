/**
 * CompletionPicker — renders a completion dropdown for the TUI.
 *
 * Pure rendering component. Takes CompletionState, renders items in an
 * emerald-themed bordered box with windowed scrolling.
 */

import { Box, Text } from "ink";
import type { CompletionState } from "@agentick/client";

const MAX_VISIBLE = 8;
const BORDER_COLOR = "#34d399";

export interface CompletionPickerProps {
  completion: CompletionState;
}

export function CompletionPicker({ completion }: CompletionPickerProps) {
  const { items, selectedIndex, loading } = completion;

  if (loading && items.length === 0) {
    return (
      <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box borderStyle="single" borderColor={BORDER_COLOR} paddingLeft={1} paddingRight={1}>
        <Text dimColor>No matches</Text>
      </Box>
    );
  }

  // Windowed scrolling — keep selected item visible
  const total = items.length;
  const windowSize = Math.min(total, MAX_VISIBLE);
  let windowStart: number;

  if (total <= MAX_VISIBLE) {
    windowStart = 0;
  } else {
    // Center the selected item in the window
    const half = Math.floor(windowSize / 2);
    windowStart = Math.max(0, Math.min(selectedIndex - half, total - windowSize));
  }

  const windowEnd = windowStart + windowSize;
  const visibleItems = items.slice(windowStart, windowEnd);
  const hasItemsAbove = windowStart > 0;
  const hasItemsBelow = windowEnd < total;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BORDER_COLOR}
      paddingLeft={1}
      paddingRight={1}
    >
      {hasItemsAbove && <Text dimColor> ...</Text>}
      {visibleItems.map((item, i) => {
        const actualIndex = windowStart + i;
        const isSelected = actualIndex === selectedIndex;

        return (
          <Box key={actualIndex} flexDirection="row" gap={1}>
            <Text inverse={isSelected} bold={isSelected}>
              {item.label}
            </Text>
            {item.description && <Text dimColor>{item.description}</Text>}
          </Box>
        );
      })}
      {hasItemsBelow && <Text dimColor> ...</Text>}
      {loading && <Text dimColor> Loading...</Text>}
    </Box>
  );
}
