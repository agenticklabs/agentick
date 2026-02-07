/**
 * Agent Component
 *
 * High-level component that renders common agent boilerplate:
 * system prompt, tools, knobs, timeline, and model configuration.
 *
 * Used directly by Level 1/2 users who write components, and
 * indirectly by Level 0 users via createAgent().
 */

import React from "react";
import { Model } from "./model";
import { Timeline } from "./timeline";
import { Knobs } from "../../hooks/knobs-component";
import { useKnob, type KnobDescriptor } from "../../hooks/knob";
import type { ToolClass } from "../../tool/tool";
import type { EngineModel } from "../../model/model";

const h = React.createElement;

/**
 * Internal: calls useKnob for a declarative knob prop. Renders nothing.
 *
 * Satisfies React's rules of hooks — can't call hooks in a loop,
 * but CAN render components in a loop (each gets its own hook state).
 */
function KnobBinding({ name, descriptor }: { name: string; descriptor: KnobDescriptor }) {
  useKnob(name, descriptor);
  return null;
}

export interface AgentProps {
  /** System prompt. Rendered as <section id="system" audience="model">. */
  system?: string;
  /** Model adapter. Rendered as <Model model={...} />. */
  model?: EngineModel;
  /** Tools (ToolClass values). Each rendered as a JSX component. */
  tools?: ToolClass[];
  /** Declarative knobs. Each binds via useKnob(name, descriptor). */
  knobs?: Record<string, KnobDescriptor>;
  /** Additional children (extra sections, tools, etc.). */
  children?: React.ReactNode;
}

/**
 * High-level agent component that renders common boilerplate.
 *
 * Renders in order:
 * 1. Model configuration (if provided)
 * 2. System prompt section (if provided)
 * 3. Tool components
 * 4. KnobBinding children (each calls useKnob, renders null)
 * 5. User's children
 * 6. <Knobs /> — aggregated knob section + set_knob tool
 * 7. <Timeline /> — conversation history (last, so messages are at bottom of context)
 *
 * @example Level 1: Wrap with a component
 * ```tsx
 * function MyAgent() {
 *   return (
 *     <Agent
 *       system="You are a helpful assistant."
 *       model={openai("gpt-4o")}
 *       tools={[SearchTool, CalculatorTool]}
 *       knobs={{ mode: knob("quick", { description: "Research depth", options: ["quick", "deep"] }) }}
 *     >
 *       <MyCustomSection />
 *     </Agent>
 *   );
 * }
 * ```
 *
 * @example Level 0: Used internally by createAgent()
 * ```tsx
 * createAgent({
 *   system: "You are helpful.",
 *   tools: [SearchTool],
 *   knobs: { mode: knob("quick", { description: "Depth" }) },
 * });
 * ```
 */
export function Agent({ system, model, tools, knobs, children }: AgentProps): React.ReactElement {
  return h(
    React.Fragment,
    null,
    // 1. Model configuration
    model && h(Model, { model }),
    // 2. System prompt section
    system && h("section", { id: "system", audience: "model" }, system),
    // 3. Tool components
    ...(tools ?? []).map((T) => h(T, { key: (T as any).metadata?.name })),
    // 4. Knob bindings
    ...Object.entries(knobs ?? {}).map(([name, desc]) =>
      h(KnobBinding, { key: name, name, descriptor: desc }),
    ),
    // 5. User's children
    children,
    // 6. Knobs section + set_knob tool
    h(Knobs),
    // 7. Timeline
    h(Timeline),
  );
}
