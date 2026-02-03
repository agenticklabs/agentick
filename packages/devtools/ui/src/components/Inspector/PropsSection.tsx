import { useState } from "react";

interface PropsSectionProps {
  props: Record<string, unknown>;
}

/**
 * Format a value for display.
 */
function formatValue(value: unknown, maxLength = 60): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > maxLength) return `"${value.slice(0, maxLength)}..."`;
    return `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "[Function]";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Special handling for serialized types
    if (obj._type === "Signal") {
      return `Signal(${formatValue(obj.value, 30)})`;
    }
    if (obj._type === "Computed") {
      return `Computed(${formatValue(obj.value, 30)})`;
    }
    if (obj._type === "Error") {
      return `Error: ${obj.message}`;
    }

    const keys = Object.keys(obj).filter((k) => !k.startsWith("_"));
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) return `{${keys.join(", ")}}`;
    return `{${keys.slice(0, 3).join(", ")}, ...}`;
  }
  return String(value);
}

export function PropsSection({ props }: PropsSectionProps) {
  const [expanded, setExpanded] = useState(true);

  const entries = Object.entries(props).filter(([key]) => !key.startsWith("_"));

  if (entries.length === 0) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" onClick={() => setExpanded(!expanded)}>
        <span className={`inspector-section-toggle ${expanded ? "expanded" : ""}`}>&#9654;</span>
        <span className="inspector-section-title">Props</span>
        <span className="inspector-section-count">{entries.length}</span>
      </div>

      {expanded && (
        <div className="inspector-section-content">
          {entries.map(([key, value]) => (
            <div key={key} className="inspector-prop">
              <span className="inspector-prop-key">{key}:</span>
              <span className="inspector-prop-value" title={String(value)}>
                {formatValue(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
