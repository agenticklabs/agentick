/**
 * Agent Component
 *
 * High-level component that renders common agent boilerplate:
 * system prompt, model config, tools, knobs, timeline, and sections.
 *
 * Used directly by Level 1/2 users who write components, and
 * indirectly by Level 0 users via createAgent().
 */

import React from "react";
import {
  Model,
  Section,
  Timeline,
  Knobs,
  useKnob,
  type KnobDescriptor,
  type ToolClass,
  type EngineModel,
  type ProviderGenerationOptions,
  type CompactionStrategy,
  type COMTimelineEntry,
} from "@tentickle/core";
import type { ResponseFormat } from "@tentickle/shared";

// ============================================================================
// Types
// ============================================================================

/**
 * Token budget configuration for the agent.
 */
export interface AgentTokenBudgetConfig {
  maxTokens: number;
  strategy?: CompactionStrategy;
  onEvict?: (entries: COMTimelineEntry[]) => void;
  guidance?: string;
  headroom?: number;
}

/**
 * Timeline configuration for the agent.
 * Set to `false` to suppress timeline entirely.
 */
export type AgentTimelineConfig =
  | {
      limit?: number;
      roles?: ("user" | "assistant" | "tool" | "system" | "event")[];
    }
  | false;

/**
 * Section configuration for declarative sections.
 */
export interface AgentSectionConfig {
  id: string;
  content?: string | React.ReactNode;
  audience?: "model" | "user" | "all";
}

/**
 * Props for the Agent component.
 *
 * Extends core's basic AgentProps with model options, timeline config,
 * token budget, and declarative sections.
 */
export interface AgentProps {
  /** System prompt. Rendered as a model-visible section. */
  system?: string;
  /** Model adapter. Rendered as <Model model={...} />. */
  model?: EngineModel;
  /** Tools (ToolClass values). Each rendered as a JSX component. */
  tools?: ToolClass[];
  /** Declarative knobs. Each binds via useKnob(name, descriptor). */
  knobs?: Record<string, KnobDescriptor<any, any>>;
  /** Additional children (extra sections, tools, etc.). */
  children?: React.ReactNode;

  // Model options (forwarded to <Model>):
  /** Structured output format. */
  responseFormat?: ResponseFormat;
  /** Sampling temperature. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Top-p (nucleus) sampling. */
  topP?: number;
  /** Provider-specific generation options. */
  providerOptions?: ProviderGenerationOptions;

  // Timeline config:
  /** Timeline options, or `false` to suppress timeline. */
  timeline?: AgentTimelineConfig;

  // Token budget:
  /** Token budget configuration. Applied to Timeline via props. */
  tokenBudget?: AgentTokenBudgetConfig;

  // Sections:
  /** Declarative sections rendered in order. */
  sections?: AgentSectionConfig[];
}

// ============================================================================
// KnobBinding — internal helper
// ============================================================================

/**
 * Internal: calls useKnob for a declarative knob prop. Renders nothing.
 *
 * Satisfies React's rules of hooks — can't call hooks in a loop,
 * but CAN render components in a loop (each gets its own hook state).
 */
function KnobBinding({ name, descriptor }: { name: string; descriptor: KnobDescriptor<any, any> }) {
  useKnob(name, descriptor);
  return null;
}

// ============================================================================
// Agent Component
// ============================================================================

/**
 * High-level agent component that renders common boilerplate.
 *
 * Renders in order:
 * 1. Model configuration (with model options)
 * 2. System prompt section (if provided)
 * 3. Tool components
 * 4. KnobBinding children (each calls useKnob, renders null)
 * 5. Declarative sections (from sections prop)
 * 6. User's children
 * 7. <Knobs /> — aggregated knob section + set_knob tool
 * 8. Timeline (with optional budget props), unless timeline===false
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
 *       temperature={0.7}
 *       tokenBudget={{ maxTokens: 8000, headroom: 500 }}
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
export function Agent(props: AgentProps): React.ReactElement {
  const {
    system,
    model,
    tools,
    knobs,
    children,
    responseFormat,
    temperature,
    maxTokens,
    topP,
    providerOptions,
    timeline,
    tokenBudget,
    sections,
  } = props;

  // Build model options — only render Model if there's something to configure
  const hasModelOptions =
    model ||
    responseFormat !== undefined ||
    temperature !== undefined ||
    maxTokens !== undefined ||
    topP !== undefined ||
    providerOptions !== undefined;

  return (
    <>
      {/* 1. Model configuration */}
      {hasModelOptions && (
        <Model
          model={model!}
          responseFormat={responseFormat}
          temperature={temperature}
          maxTokens={maxTokens}
          topP={topP}
          providerOptions={providerOptions}
        />
      )}

      {/* 2. System prompt section */}
      {system && (
        <Section id="system" audience="model">
          {system}
        </Section>
      )}

      {/* 3. Tool components */}
      {(tools ?? []).map((T) => (
        <T key={(T as any).metadata?.name} />
      ))}

      {/* 4. Knob bindings */}
      {Object.entries(knobs ?? {}).map(([name, desc]) => (
        <KnobBinding key={name} name={name} descriptor={desc} />
      ))}

      {/* 5. Declarative sections */}
      {(sections ?? []).map((sec) => (
        <Section key={sec.id} id={sec.id} audience={sec.audience ?? "model"}>
          {sec.content}
        </Section>
      ))}

      {/* 6. User's children */}
      {children}

      {/* 7. Knobs section + set_knob tool */}
      <Knobs />

      {/* 8. Timeline (with optional budget props) */}
      {timeline !== false && (
        <Timeline
          limit={typeof timeline === "object" ? timeline.limit : undefined}
          roles={typeof timeline === "object" ? timeline.roles : undefined}
          maxTokens={tokenBudget?.maxTokens}
          strategy={tokenBudget?.strategy}
          onEvict={tokenBudget?.onEvict}
          guidance={tokenBudget?.guidance}
          headroom={tokenBudget?.headroom}
        />
      )}
    </>
  );
}

// TODO: documents prop — RAG context
// TODO: identity section — name, role, personality
// TODO: skills — composable behavior bundles
