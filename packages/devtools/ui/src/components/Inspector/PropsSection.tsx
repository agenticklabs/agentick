import { useState } from "react";

interface PropsSectionProps {
  props: Record<string, unknown>;
}

/**
 * Expandable value component for nested objects/arrays.
 */
function ExpandableValue({
  name,
  value,
  depth = 0,
}: {
  name: string;
  value: unknown;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1); // Auto-expand first level

  // Determine if value is expandable (object or non-empty array)
  const isExpandable =
    value !== null &&
    typeof value === "object" &&
    !isSpecialType(value) &&
    (Array.isArray(value) ? value.length > 0 : Object.keys(value as object).length > 0);

  const preview = formatPreview(value);
  const typeLabel = getTypeLabel(value);

  if (!isExpandable) {
    return (
      <div className="inspector-prop" style={{ paddingLeft: depth * 12 }}>
        <span className="inspector-prop-key">{name}:</span>
        <span className="inspector-prop-value" title={String(value)}>
          {preview}
        </span>
      </div>
    );
  }

  return (
    <div className="inspector-prop-expandable" style={{ paddingLeft: depth * 12 }}>
      <div
        className="inspector-prop-header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: "pointer" }}
      >
        <span className={`inspector-prop-toggle ${expanded ? "expanded" : ""}`}>▶</span>
        <span className="inspector-prop-key">{name}:</span>
        <span className="inspector-prop-type">{typeLabel}</span>
      </div>
      {expanded && (
        <div className="inspector-prop-children">
          {Array.isArray(value)
            ? value.map((item, index) => (
                <ExpandableValue key={index} name={`[${index}]`} value={item} depth={depth + 1} />
              ))
            : Object.entries(value as Record<string, unknown>)
                .filter(([key]) => !key.startsWith("_"))
                .map(([key, val]) => (
                  <ExpandableValue key={key} name={key} value={val} depth={depth + 1} />
                ))}
        </div>
      )}
    </div>
  );
}

/**
 * Check if value is a special serialized type (displayed as leaf, not expandable).
 */
function isSpecialType(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj._type === "Signal" ||
    obj._type === "Computed" ||
    obj._type === "Error" ||
    isSchemaObject(obj)
  );
}

/**
 * Check if value looks like a schema object (Zod, Standard Schema, etc.)
 * Detection patterns aligned with @tentickle/kernel/schema.ts
 */
function isSchemaObject(obj: Record<string, unknown>): boolean {
  // Standard Schema v1: has ~standard property with version and vendor
  const standard = obj["~standard"] as Record<string, unknown> | undefined;
  if (standard && typeof standard === "object" && standard.version === 1) {
    return true;
  }
  // Zod 3/4: has _def with typeName starting with "Zod"
  const def = obj._def as Record<string, unknown> | undefined;
  if (def && typeof def.typeName === "string" && (def.typeName as string).startsWith("Zod")) {
    return true;
  }
  return false;
}

/**
 * Get a human-readable label for a schema object.
 * Detection patterns aligned with @tentickle/kernel/schema.ts
 *
 * Note: Schema internals (like _def.shape) are functions that don't serialize
 * over the wire. We show a simplified label based on what does serialize.
 */
function getSchemaLabel(obj: Record<string, unknown>): string {
  const standard = obj["~standard"] as Record<string, unknown> | undefined;
  const def = obj._def as Record<string, unknown> | undefined;

  // Get vendor from Standard Schema
  const vendor = standard?.vendor as string | undefined;

  // Try to get Zod type info from _def
  if (def?.typeName) {
    const typeName = def.typeName as string;
    const type = typeName.replace(/^Zod/, "").toLowerCase();
    return `z.${type}()`;
  }

  // Fall back to vendor name
  if (vendor) {
    return `${vendor} schema`;
  }

  return "Schema";
}

/**
 * Get a type label for expandable values.
 */
function getTypeLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // Schema objects
    if (isSchemaObject(obj)) {
      return getSchemaLabel(obj);
    }

    // Special handling for message objects
    if ("role" in obj && "content" in obj) {
      const role = obj.role as string;
      return `Message(${role})`;
    }

    // Content block
    if ("type" in obj) {
      const type = obj.type as string;
      if (type === "text" && "text" in obj) {
        const text = obj.text as string;
        const preview = text.length > 30 ? text.slice(0, 30) + "..." : text;
        return `TextBlock("${preview}")`;
      }
      if (type === "tool_use" && "name" in obj) {
        return `ToolUse(${obj.name})`;
      }
      if (type === "tool_result") {
        return `ToolResult`;
      }
      return `{type: "${type}"}`;
    }

    const keys = Object.keys(obj).filter((k) => !k.startsWith("_"));
    return `Object(${keys.length})`;
  }
  return typeof value;
}

/**
 * Format a preview for leaf values.
 */
function formatPreview(value: unknown, maxLength = 80): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  if (typeof value === "string") {
    if (value.length > maxLength) return `"${value.slice(0, maxLength)}..."`;
    return `"${value}"`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // Schema objects - show type label
    if (isSchemaObject(obj)) {
      return getSchemaLabel(obj);
    }

    // Special handling for serialized types
    if (obj._type === "Signal") {
      return `Signal(${formatPreview(obj.value, 30)})`;
    }
    if (obj._type === "Computed") {
      return `Computed(${formatPreview(obj.value, 30)})`;
    }
    if (obj._type === "Error") {
      return `Error: ${obj.message}`;
    }

    // Message preview
    if ("role" in obj && "content" in obj) {
      const role = obj.role as string;
      const content = obj.content as unknown[];
      const textBlocks = content?.filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      );
      const text = textBlocks?.map((b) => b.text).join(" ") ?? "";
      const preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
      return `{role: "${role}", "${preview}"}`;
    }

    // Content block preview
    if ("type" in obj) {
      const type = obj.type as string;
      if (type === "text" && "text" in obj) {
        const text = obj.text as string;
        const preview = text.length > 50 ? text.slice(0, 50) + "..." : text;
        return `"${preview}"`;
      }
      if (type === "tool_use" && "name" in obj) {
        const input = obj.input as Record<string, unknown> | undefined;
        const inputPreview = input ? Object.keys(input).slice(0, 2).join(", ") : "";
        return `→ ${obj.name}(${inputPreview}${inputPreview && Object.keys(input ?? {}).length > 2 ? "..." : ""})`;
      }
      if (type === "tool_result") {
        // Extract text from nested content
        const content = obj.content as unknown[] | undefined;
        if (Array.isArray(content)) {
          const textParts = content
            .filter(
              (c): c is { type: string; text: string } =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            )
            .map((c) => c.text);
          if (textParts.length > 0) {
            const text = textParts.join(" ");
            const preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
            return `← "${preview}"`;
          }
        }
        return `← tool_result`;
      }
      return `{type: "${type}"}`;
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
        <span className={`inspector-section-toggle ${expanded ? "expanded" : ""}`}>▶</span>
        <span className="inspector-section-title">Props</span>
        <span className="inspector-section-count">{entries.length}</span>
      </div>

      {expanded && (
        <div className="inspector-section-content">
          {entries.map(([key, value]) => (
            <ExpandableValue key={key} name={key} value={value} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
