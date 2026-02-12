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
import { useRuntimeStore, type KnobRegistration } from "./runtime-context";
import { useCom } from "./context";
import { createTool } from "../tool/tool";
import type { COM } from "../com/object-model";

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
}

export interface KnobGroup {
  name: string; // group name, or "" for ungrouped
  knobs: KnobInfo[];
}

export interface KnobsContextValue {
  knobs: KnobInfo[];
  groups: KnobGroup[];
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
  };
}

function buildGroups(knobs: Map<string, KnobRegistration>): KnobGroup[] {
  const ungrouped: KnobInfo[] = [];
  const grouped = new Map<string, KnobInfo[]>();

  for (const [, reg] of knobs) {
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

function formatKnobsForModel(groups: KnobGroup[]): string {
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

  return lines.join("\n").trimEnd();
}

// ============================================================================
// Validation
// ============================================================================

function error(text: string) {
  return [{ type: "text" as const, text }];
}

function executeSetKnob(
  knobs: Map<string, KnobRegistration>,
  input: { name: string; value: string | number | boolean },
) {
  const knob = knobs.get(input.name);
  if (!knob) {
    return error(`Unknown knob "${input.name}". Available: ${[...knobs.keys()].join(", ")}`);
  }

  // Type check
  if (typeof input.value !== knob.valueType) {
    return error(
      `Invalid type for "${input.name}". Expected ${knob.valueType}, got ${typeof input.value}.`,
    );
  }

  // Options check (enum constraint)
  if (knob.options?.length && !knob.options.some((o) => o === input.value)) {
    const opts = knob.options.map(formatValue).join(", ");
    return error(`Invalid value for "${input.name}". Valid options: ${opts}`);
  }

  // Number constraints
  if (typeof input.value === "number") {
    if (knob.min !== undefined && input.value < knob.min) {
      return error(`Value for "${input.name}" must be >= ${knob.min}. Got ${input.value}.`);
    }
    if (knob.max !== undefined && input.value > knob.max) {
      return error(`Value for "${input.name}" must be <= ${knob.max}. Got ${input.value}.`);
    }
  }

  // String constraints
  if (typeof input.value === "string") {
    if (knob.maxLength !== undefined && input.value.length > knob.maxLength) {
      return error(
        `Value for "${input.name}" exceeds max length of ${knob.maxLength}. Got ${input.value.length} chars.`,
      );
    }
    if (knob.pattern !== undefined && !new RegExp(knob.pattern).test(input.value)) {
      return error(`Value for "${input.name}" does not match pattern: ${knob.pattern}`);
    }
  }

  // Custom validate
  if (knob.validate) {
    const result = knob.validate(input.value);
    if (result !== true) {
      return error(`Validation failed for "${input.name}": ${result}`);
    }
  }

  knob.setPrimitive(input.value);
  return [{ type: "text" as const, text: `Set ${input.name} to ${formatValue(input.value)}.` }];
}

// ============================================================================
// SetKnobTool — tool-only, no render
// ============================================================================

const SetKnobTool = createTool({
  name: "set_knob",
  description: "Set a knob value. See the knobs section for available knobs and options.",
  input: z.object({
    name: z.string().describe("Name of the knob to set"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value for the knob"),
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

  if (typeof props.children === "function") {
    // Render prop: tool + custom content
    return h(React.Fragment, null, h(SetKnobTool), props.children(groups));
  }

  // Default: tool + default section
  return h(
    React.Fragment,
    null,
    h(SetKnobTool),
    h("section", { id: "knobs", audience: "model" }, formatKnobsForModel(groups)),
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

  const contextValue: KnobsContextValue = {
    knobs,
    groups,
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
  return h("section", { id: "knobs", audience: "model" }, formatKnobsForModel(context.groups));
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
