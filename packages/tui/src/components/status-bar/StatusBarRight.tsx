/**
 * StatusBarRight — right-side composition for DefaultStatusBar.
 *
 * Renders as a child of StatusBar so it has access to StatusBarContext.
 * Dogfoods the widget components and adapts to terminal width.
 */

import { Text } from "ink";
import { ModelInfo } from "./widgets/ModelInfo.js";
import { TokenCount } from "./widgets/TokenCount.js";
import { ContextUtilization } from "./widgets/ContextUtilization.js";
import { StateIndicator } from "./widgets/StateIndicator.js";
import { Separator } from "./widgets/Separator.js";
import { useStatusBarData } from "./context.js";

interface StatusBarRightProps {
  width: number;
}

export function StatusBarRight({ width }: StatusBarRightProps) {
  const data = useStatusBarData();
  const ci = data?.contextInfo;

  const hasModel = !!(ci?.modelName ?? ci?.modelId);
  const hasTokens = (ci?.cumulativeUsage?.totalTokens ?? ci?.totalTokens ?? 0) > 0;
  const hasUtil = ci?.utilization != null;

  // Wide (80+): model | 6.2K 35% | idle
  // Medium (60-79): model | idle
  // Narrow (<60): idle
  const showModel = hasModel && width >= 60;
  const showTokens = hasTokens && width >= 80;
  const showUtil = hasUtil && width >= 80;

  return (
    <Text>
      {showModel && (
        <>
          <ModelInfo />
          <Separator />
        </>
      )}
      {showTokens && (
        <>
          <TokenCount cumulative />
          {showUtil && (
            <>
              <Text> </Text>
              <ContextUtilization />
            </>
          )}
          <Separator />
        </>
      )}
      <StateIndicator />
    </Text>
  );
}
