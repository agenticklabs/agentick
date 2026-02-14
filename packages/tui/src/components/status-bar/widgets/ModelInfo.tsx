import { Text } from "ink";
import { useStatusBarData } from "../context.js";

interface ModelInfoProps {
  modelName?: string;
  color?: string;
}

export function ModelInfo({ modelName, color }: ModelInfoProps) {
  const data = useStatusBarData();
  const ci = data?.contextInfo;
  const display = modelName ?? ci?.modelName ?? ci?.modelId ?? "\u2014";
  return <Text color={color}>{display}</Text>;
}
