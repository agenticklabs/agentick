import { Text } from "ink";

interface BrandLabelProps {
  name?: string;
  color?: string;
  bold?: boolean;
}

export function BrandLabel({ name = "agentick", color = "#34d399", bold = true }: BrandLabelProps) {
  return (
    <Text color={color} bold={bold}>
      {name}
    </Text>
  );
}
