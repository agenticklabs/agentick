import { useState } from "react";
import type { HookState } from "../../hooks/useDevToolsEvents.js";

interface HooksSectionProps {
  hooks: HookState[];
}

/**
 * Format hook value for display.
 */
function formatHookValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > 50) return `"${value.slice(0, 50)}..."`;
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

    // Special handling for Signal/Computed values
    if (obj._type === "Signal") {
      return `Signal(${formatHookValue(obj.value)})`;
    }
    if (obj._type === "Computed") {
      return `Computed(${formatHookValue(obj.value)})`;
    }

    const keys = Object.keys(obj).filter((k) => !k.startsWith("_"));
    if (keys.length === 0) return "{}";
    if (keys.length <= 2) return `{${keys.join(", ")}}`;
    return `{${keys.slice(0, 2).join(", ")}, ...}`;
  }
  return String(value);
}

/**
 * Get hook type badge color.
 */
function getHookTypeClass(type: string): string {
  switch (type.toLowerCase()) {
    case "usestate":
    case "state":
      return "hook-state";
    case "useeffect":
    case "effect":
      return "hook-effect";
    case "useref":
    case "ref":
      return "hook-ref";
    case "usememo":
    case "memo":
      return "hook-memo";
    case "usecallback":
    case "callback":
      return "hook-callback";
    case "usecontext":
    case "context":
      return "hook-context";
    case "usesignal":
    case "signal":
      return "hook-signal";
    default:
      return "hook-other";
  }
}

export function HooksSection({ hooks }: HooksSectionProps) {
  const [expanded, setExpanded] = useState(true);

  if (hooks.length === 0) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" onClick={() => setExpanded(!expanded)}>
        <span className={`inspector-section-toggle ${expanded ? "expanded" : ""}`}>&#9654;</span>
        <span className="inspector-section-title">Hooks</span>
        <span className="inspector-section-count">{hooks.length}</span>
      </div>

      {expanded && (
        <div className="inspector-section-content">
          {hooks.map((hook) => (
            <div key={hook.index} className="inspector-hook">
              <span className={`inspector-hook-type ${getHookTypeClass(hook.type)}`}>
                {hook.type}[{hook.index}]
              </span>
              <span className="inspector-hook-value">{formatHookValue(hook.value)}</span>
              {hook.deps && (
                <span className="inspector-hook-deps" title={`${hook.deps.length} dependencies`}>
                  deps: [{hook.deps.length}]
                </span>
              )}
              {hook.status && <span className="inspector-hook-status">{hook.status}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
