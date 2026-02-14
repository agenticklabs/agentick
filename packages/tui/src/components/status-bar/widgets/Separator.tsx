import { Text } from "ink";

interface SeparatorProps {
  char?: string;
  color?: string;
}

export function Separator({ char = "|", color = "gray" }: SeparatorProps) {
  return <Text color={color}> {char} </Text>;
}
