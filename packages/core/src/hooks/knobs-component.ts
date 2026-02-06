/**
 * Knobs — a stateful tool that renders knob state + provides set_knob.
 *
 * Uses the createTool stateful tool pattern:
 * - handler: validates and sets knob primitives via COM state
 * - render: shows all registered knobs as a model-visible section
 *
 * Place <Knobs /> in your component tree. Renders nothing if no knobs exist.
 */

import React from "react";
import { z } from "zod";
import { useRuntimeStore, type KnobRegistration } from "./runtime-context";
import { useCom } from "./context";
import { createTool } from "../tool/tool";
import type { COM } from "../com/object-model";

const h = React.createElement;

/** COM state key where the knob registry is stashed for the tool handler. */
const KNOB_REGISTRY_KEY = "__knobRegistry";

// ============================================================================
// Formatting + Validation
// ============================================================================

function formatKnobsForModel(knobs: Map<string, KnobRegistration>): string {
  const lines: string[] = [
    "Knobs are adjustable parameters you can modify using the set_knob tool.",
    "",
  ];

  for (const [, knob] of knobs) {
    const raw = knob.getPrimitive();
    const display = typeof raw === "string" ? `"${raw}"` : String(raw);
    lines.push(`${knob.name}: ${display}`);
    lines.push(`  ${knob.description}`);
    if (knob.options?.length) {
      lines.push(
        `  Options: ${knob.options.map((o) => (typeof o === "string" ? `"${o}"` : String(o))).join(", ")}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function executeSetKnob(
  knobs: Map<string, KnobRegistration>,
  input: { name: string; value: string | number | boolean },
) {
  const knob = knobs.get(input.name);
  if (!knob) {
    return [
      {
        type: "text" as const,
        text: `Unknown knob "${input.name}". Available: ${[...knobs.keys()].join(", ")}`,
      },
    ];
  }

  if (knob.options?.length && !knob.options.some((o) => o === input.value)) {
    const opts = knob.options.map((o) => (typeof o === "string" ? `"${o}"` : String(o))).join(", ");
    return [
      { type: "text" as const, text: `Invalid value for "${input.name}". Valid options: ${opts}` },
    ];
  }

  if (typeof input.value !== knob.valueType) {
    return [
      {
        type: "text" as const,
        text: `Invalid type for "${input.name}". Expected ${knob.valueType}, got ${typeof input.value}.`,
      },
    ];
  }

  knob.setPrimitive(input.value);
  const display = typeof input.value === "string" ? `"${input.value}"` : String(input.value);
  return [{ type: "text" as const, text: `Set ${input.name} to ${display}.` }];
}

// ============================================================================
// SetKnobTool — stateful tool (handler + render)
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

  render: (_tickState, ctx) => {
    const knobs = ctx?.getState<Map<string, KnobRegistration>>(KNOB_REGISTRY_KEY);
    if (!knobs?.size) return null;
    return h("section", { id: "knobs", audience: "model" }, formatKnobsForModel(knobs));
  },
});

// ============================================================================
// <Knobs /> — conditional wrapper
// ============================================================================

/**
 * Place once in your component tree. Renders the set_knob tool + knob section
 * when knobs are registered, nothing otherwise.
 */
export function Knobs(): React.ReactElement | null {
  const store = useRuntimeStore();
  const ctx = useCom();

  if (store.knobRegistry.size === 0) {
    return null;
  }

  // Stash registry on COM so the tool handler can access it via ctx.getState().
  // Intentional render-time side effect — safe in Tentickle's synchronous reconciler.
  ctx.setState(KNOB_REGISTRY_KEY, store.knobRegistry);

  return h(SetKnobTool);
}
