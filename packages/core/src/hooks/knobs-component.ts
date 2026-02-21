/**
 * Knobs — provider pattern for model-visible knob state.
 *
 * Three modes:
 * 1. `<Knobs />`               — default rendering (tool + section)
 * 2. `<Knobs>{(groups) => …}</Knobs>` — render prop for custom section
 * 3. `<Knobs.Provider>` + `useKnobsContext()` — full custom rendering
 *
 * The set_knob tool is always registered automatically in all three modes.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import { z } from "zod";
import { useRuntimeStore, type KnobRegistration } from "./runtime-context.js";
import { useCom } from "./context.js";
import { createTool } from "../tool/tool.js";
import type { COM } from "../com/object-model.js";
import { Section } from "../jsx/index.js";

const h = React.createElement;

/** COM state key where the knob registry is stashed for the tool handler. */
const KNOB_REGISTRY_KEY = "__knobRegistry";

// ============================================================================
// Types
// ============================================================================

/** Read-only snapshot of a knob for rendering. */
export interface KnobInfo {
  name: string;
  description: string;
  value: string | number | boolean;
  defaultValue: string | number | boolean;
  semanticType: "toggle" | "range" | "number" | "select" | "text";
  valueType: "string" | "number" | "boolean";
  group?: string;
  options?: (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  pattern?: string;
  required?: boolean;
  momentary?: boolean;
  inline?: boolean;
}

export interface KnobGroup {
  name: string; // group name, or "" for ungrouped
  knobs: KnobInfo[];
}

export interface KnobsContextValue {
  knobs: KnobInfo[];
  groups: KnobGroup[];
  hasInlineKnobs: boolean;
  get: (name: string) => KnobInfo | undefined;
}

export type KnobsRenderFn = (groups: KnobGroup[]) => React.ReactElement | null;

export interface KnobsProps {
  children?: KnobsRenderFn;
}

// ============================================================================
// React Context
// ============================================================================

const KnobsContext = createContext<KnobsContextValue | null>(null);

// ============================================================================
// Semantic Type Inference
// ============================================================================

function inferSemanticType(knob: KnobRegistration): KnobInfo["semanticType"] {
  if (knob.valueType === "boolean") return "toggle";
  if (knob.valueType === "number" && (knob.min !== undefined || knob.max !== undefined))
    return "range";
  if (knob.valueType === "number") return "number";
  if (knob.valueType === "string" && knob.options?.length) return "select";
  return "text";
}

// ============================================================================
// KnobInfo / KnobGroup Builders
// ============================================================================

function buildKnobInfo(reg: KnobRegistration): KnobInfo {
  return {
    name: reg.name,
    description: reg.description,
    value: reg.getPrimitive(),
    defaultValue: reg.defaultValue,
    semanticType: inferSemanticType(reg),
    valueType: reg.valueType,
    group: reg.group,
    options: reg.options,
    min: reg.min,
    max: reg.max,
    step: reg.step,
    maxLength: reg.maxLength,
    pattern: reg.pattern,
    required: reg.required,
    momentary: reg.momentary,
    inline: reg.inline,
  };
}

function buildGroups(knobs: Map<string, KnobRegistration>): KnobGroup[] {
  const ungrouped: KnobInfo[] = [];
  const grouped = new Map<string, KnobInfo[]>();

  for (const [, reg] of knobs) {
    if (reg.inline) continue;
    const info = buildKnobInfo(reg);
    if (reg.group) {
      const list = grouped.get(reg.group) ?? [];
      list.push(info);
      grouped.set(reg.group, list);
    } else {
      ungrouped.push(info);
    }
  }

  const result: KnobGroup[] = [];
  if (ungrouped.length > 0) {
    result.push({ name: "", knobs: ungrouped });
  }
  for (const [name, knobs] of grouped) {
    result.push({ name, knobs });
  }
  return result;
}

// ============================================================================
// Formatting
// ============================================================================

function formatValue(value: string | number | boolean): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function formatKnobLine(knob: KnobInfo): string {
  const typeLabel = knob.momentary ? `momentary ${knob.semanticType}` : knob.semanticType;
  const parts: string[] = [
    `${knob.name} [${typeLabel}]: ${formatValue(knob.value)} — ${knob.description}`,
  ];

  const hints: string[] = [];
  if (knob.options?.length) {
    hints.push(`options: ${knob.options.map(formatValue).join(", ")}`);
  }
  if (knob.min !== undefined || knob.max !== undefined) {
    const range = `${knob.min ?? "*"} - ${knob.max ?? "*"}`;
    hints.push(range);
  }
  if (knob.step !== undefined) hints.push(`step ${knob.step}`);
  if (knob.maxLength !== undefined) hints.push(`max ${knob.maxLength} chars`);
  if (knob.pattern !== undefined) hints.push(`pattern: ${knob.pattern}`);
  if (knob.required) hints.push("required");
  if (knob.momentary) hints.push("resets after use");

  if (hints.length > 0) {
    parts.push(` (${hints.join(", ")})`);
  }

  return parts.join("");
}

function formatKnobsForModel(groups: KnobGroup[], hasInlineKnobs?: boolean): string {
  const lines: string[] = [
    "Knobs are adjustable parameters you can modify using the set_knob tool.",
    "",
  ];

  let firstGroup = true;
  for (const group of groups) {
    if (group.name === "") {
      // Ungrouped knobs (no header)
      for (const knob of group.knobs) {
        lines.push(formatKnobLine(knob));
      }
    } else {
      if (!firstGroup || lines.length > 2) lines.push("");
      lines.push(`### ${group.name}`);
      for (const knob of group.knobs) {
        lines.push(formatKnobLine(knob));
      }
    }
    firstGroup = false;
  }

  if (hasInlineKnobs) {
    lines.push("");
    lines.push(
      "Content tagged <collapsed> can be expanded via set_knob (use name for one, group for batch).",
    );
  }

  return lines.join("\n").trimEnd();
}

// ============================================================================
// Validation
// ============================================================================

function error(text: string) {
  return [{ type: "text" as const, text }];
}

function validateAndSetKnob(
  knob: KnobRegistration,
  value: string | number | boolean,
): string | null {
  if (typeof value !== knob.valueType) {
    return `Invalid type for "${knob.name}". Expected ${knob.valueType}, got ${typeof value}.`;
  }
  if (knob.options?.length && !knob.options.some((o) => o === value)) {
    return `Invalid value for "${knob.name}". Valid options: ${knob.options.map(formatValue).join(", ")}`;
  }
  if (typeof value === "number") {
    if (knob.min !== undefined && value < knob.min) {
      return `Value for "${knob.name}" must be >= ${knob.min}. Got ${value}.`;
    }
    if (knob.max !== undefined && value > knob.max) {
      return `Value for "${knob.name}" must be <= ${knob.max}. Got ${value}.`;
    }
  }
  if (typeof value === "string") {
    if (knob.maxLength !== undefined && value.length > knob.maxLength) {
      return `Value for "${knob.name}" exceeds max length of ${knob.maxLength}. Got ${value.length} chars.`;
    }
    if (knob.pattern !== undefined && !new RegExp(knob.pattern).test(value)) {
      return `Value for "${knob.name}" does not match pattern: ${knob.pattern}`;
    }
  }
  if (knob.validate) {
    const result = knob.validate(value);
    if (result !== true) return `Validation failed for "${knob.name}": ${result}`;
  }
  knob.setPrimitive(value);
  return null;
}

function executeSetKnob(
  knobs: Map<string, KnobRegistration>,
  input: { name?: string; group?: string; value: string | number | boolean },
) {
  const hasName = input.name !== undefined && input.name !== "";
  const hasGroup = input.group !== undefined && input.group !== "";

  if (hasName && hasGroup) {
    return error("Provide either name or group, not both.");
  }
  if (!hasName && !hasGroup) {
    return error("Provide either name or group.");
  }

  if (hasName) {
    const knob = knobs.get(input.name!);
    if (!knob) {
      return error(`Unknown knob "${input.name}". Available: ${[...knobs.keys()].join(", ")}`);
    }
    const err = validateAndSetKnob(knob, input.value);
    if (err) return error(err);
    return [{ type: "text" as const, text: `Set ${input.name} to ${formatValue(input.value)}.` }];
  }

  // Group dispatch
  const targets: KnobRegistration[] = [];
  for (const [, reg] of knobs) {
    if (reg.group === input.group) targets.push(reg);
  }
  if (targets.length === 0) {
    return error(`No knobs found in group "${input.group}".`);
  }
  // Validate all types match before setting any
  const expectedType = targets[0].valueType;
  for (const t of targets) {
    if (t.valueType !== expectedType) {
      return error(
        `Type mismatch in group "${input.group}": "${t.name}" is ${t.valueType}, expected ${expectedType}.`,
      );
    }
  }
  for (const t of targets) {
    const err = validateAndSetKnob(t, input.value);
    if (err) return error(err);
  }
  const names = targets.map((t) => t.name).join(", ");
  return [
    {
      type: "text" as const,
      text: `Set ${targets.length} knobs in group "${input.group}" to ${formatValue(input.value)}: ${names}.`,
    },
  ];
}

// ============================================================================
// SetKnobTool — tool-only, no render
// ============================================================================

const SetKnobTool = createTool({
  name: "set_knob",
  description:
    "Set a knob value by name, or set all knobs in a group at once. Provide either name or group, not both.",
  input: z.object({
    name: z.string().optional().describe("Name of the knob to set (mutually exclusive with group)"),
    group: z
      .string()
      .optional()
      .describe("Group name — sets all knobs in the group (mutually exclusive with name)"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value for the knob(s)"),
  }),

  handler: (input, ctx?: COM) => {
    const knobs = ctx?.getState<Map<string, KnobRegistration>>(KNOB_REGISTRY_KEY);
    if (!knobs?.size) {
      return [{ type: "text" as const, text: "No knobs are currently registered." }];
    }
    return executeSetKnob(knobs, input);
  },
  // No render — tool registration only. Section rendered by Knobs/Provider.
});

// ============================================================================
// <Knobs /> — default + render prop
// ============================================================================

/**
 * Renders the set_knob tool + knob section when knobs are registered.
 *
 * Three modes:
 * - `<Knobs />` — default section rendering
 * - `<Knobs>{(groups) => <section>…</section>}</Knobs>` — custom section via render prop
 * - Use `<Knobs.Provider>` + `<Knobs.Controls />` for full custom rendering
 */
export function Knobs(props: KnobsProps): React.ReactElement | null {
  const store = useRuntimeStore();
  const ctx = useCom();

  if (store.knobRegistry.size === 0) {
    return null;
  }

  // Stash registry on COM so the tool handler can access it via ctx.getState().
  ctx.setState(KNOB_REGISTRY_KEY, store.knobRegistry);

  const groups = buildGroups(store.knobRegistry);
  const hasInlineKnobs = [...store.knobRegistry.values()].some((r) => r.inline);

  if (typeof props.children === "function") {
    // Render prop: tool + custom content
    return h(React.Fragment, null, h(SetKnobTool), props.children(groups));
  }

  // Default: tool + default section
  return h(
    React.Fragment,
    null,
    h(SetKnobTool),
    h(Section, { id: "knobs", audience: "model" }, formatKnobsForModel(groups, hasInlineKnobs)),
  );
}

// ============================================================================
// <Knobs.Provider>
// ============================================================================

/**
 * Provider that exposes knob context to descendants.
 * Always registers the set_knob tool.
 *
 * @example
 * ```tsx
 * <Knobs.Provider>
 *   <Knobs.Controls />
 * </Knobs.Provider>
 * ```
 */
Knobs.Provider = function KnobsProvider({ children }: { children: ReactNode }): React.ReactElement {
  const store = useRuntimeStore();
  const ctx = useCom();

  if (store.knobRegistry.size === 0) {
    return h(React.Fragment, null, children);
  }

  ctx.setState(KNOB_REGISTRY_KEY, store.knobRegistry);

  const groups = buildGroups(store.knobRegistry);
  const knobs = groups.flatMap((g) => g.knobs);
  const hasInlineKnobs = [...store.knobRegistry.values()].some((r) => r.inline);

  const contextValue: KnobsContextValue = {
    knobs,
    groups,
    hasInlineKnobs,
    get: (name) => knobs.find((k) => k.name === name),
  };

  return h(
    React.Fragment,
    null,
    h(SetKnobTool),
    h(KnobsContext.Provider, { value: contextValue }, children),
  );
};

// ============================================================================
// <Knobs.Controls>
// ============================================================================

interface KnobsControlsProps {
  renderKnob?: (knob: KnobInfo) => React.ReactElement | null;
  renderGroup?: (group: KnobGroup) => React.ReactElement | null;
}

/**
 * Renders knob content from Knobs.Provider context.
 *
 * - No props: default section rendering
 * - `renderKnob`: custom per-knob rendering
 * - `renderGroup`: custom per-group rendering
 */
Knobs.Controls = function KnobsControls(props: KnobsControlsProps): React.ReactElement {
  const context = useContext(KnobsContext);
  if (!context) return h(React.Fragment, null);

  if (props.renderGroup) {
    return h(React.Fragment, null, ...context.groups.map((g) => props.renderGroup!(g)));
  }

  if (props.renderKnob) {
    return h(React.Fragment, null, ...context.knobs.map((k) => props.renderKnob!(k)));
  }

  // Default rendering from context
  return h(
    "section",
    { id: "knobs", audience: "model" },
    formatKnobsForModel(context.groups, context.hasInlineKnobs),
  );
};

// ============================================================================
// Hooks
// ============================================================================

/**
 * Access knob context from within Knobs.Provider. Throws if not in provider.
 */
export function useKnobsContext(): KnobsContextValue {
  const context = useContext(KnobsContext);
  if (!context) {
    throw new Error("useKnobsContext must be used within a Knobs.Provider");
  }
  return context;
}

/**
 * Access knob context, returning null if not within provider.
 */
export function useKnobsContextOptional(): KnobsContextValue | null {
  return useContext(KnobsContext);
}
