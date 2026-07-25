/**
 * `<Knobs />` — model-facing presentation of registered knobs +
 * the `knob_set` tool that lets the model mutate them.
 *
 * Three modes:
 *
 *   1. `<Knobs />`                                       default rendering
 *      Renders the `knob_set` tool declaration + a `<Section id="knobs">`
 *      listing every registered knob (grouped by `group`, omitting any
 *      with `inline: true`).
 *
 *   2. `<Knobs>{(groups) => …}</Knobs>`                  render prop
 *      Renders the `knob_set` tool + caller's custom section.
 *
 *   3. `<Knobs.Provider>{children}</Knobs.Provider>`    context provider
 *      `<Knobs.Provider>` + `<Knobs.Controls />` + `useKnobsContext()`
 *      for full custom rendering. Tool registers unconditionally.
 *
 * Returns `null` when no knobs are registered (no tool, no section).
 *
 * Model-facing formatter:
 *
 *   Knobs are adjustable parameters you can modify using the knob_set tool.
 *
 *   verification [select]: "inactive" — Verification pending (options: "inactive", "active", "deferred")
 *
 *   ### controls
 *   verbose [toggle]: false — Verbose output
 *
 * The formatter emits one line per knob with `name [semantic-type]:
 * value — description`, followed by parenthesized hints (options, range,
 * pattern, etc.). Groups become `### group-name` headings; ungrouped
 * knobs print before the first heading.
 *
 * `knob_set` validation pipeline (same order as v1):
 *   1. exactly-one(name, group)
 *   2. knob exists / group has members
 *   3. type matches `valueType`
 *   4. options whitelist (when present)
 *   5. number bounds (min/max)
 *   6. string length / pattern
 *   7. custom `validate(value)`
 *
 * @see packages/core/src/hooks/knobs-component.ts (v1 origin)
 * @see packages/spec/src/protocol/hook-bridges.ts §KnobBridge
 */

import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type {
  KnobDescriptor,
  KnobPrimitive,
  KnobSemanticType,
  KnobsDispatchInput,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { useBridges } from "@agentick/compiler-react";
import { createTool } from "@agentick/compiler-react";
import { Section } from "@agentick/compiler-react";

const h = React.createElement;

// ============================================================================
// View types
// ============================================================================

/**
 * Read-only snapshot of a knob for rendering. Combines the bridge's
 * `KnobDescriptor` with a derived `semanticType` for knob_set UX.
 */
export interface KnobInfo extends KnobDescriptor {
  readonly semanticType: KnobSemanticType;
}

export interface KnobGroup {
  /** Group name; `""` for ungrouped knobs (rendered first, no heading). */
  readonly name: string;
  readonly knobs: readonly KnobInfo[];
}

export interface KnobsContextValue {
  readonly knobs: readonly KnobInfo[];
  readonly groups: readonly KnobGroup[];
  readonly hasInlineKnobs: boolean;
  readonly get: (id: string) => KnobInfo | undefined;
}

export type KnobsRenderFn = (groups: readonly KnobGroup[]) => React.ReactNode;

export interface KnobsProps {
  readonly children?: KnobsRenderFn;
}

// ============================================================================
// Context
// ============================================================================

const KnobsContext = createContext<KnobsContextValue | null>(null);

// ============================================================================
// Semantic type inference
// ============================================================================

function inferSemanticType(desc: KnobDescriptor): KnobSemanticType {
  if (desc.valueType === "boolean") return "toggle";
  if (desc.valueType === "number" && (desc.min !== undefined || desc.max !== undefined))
    return "range";
  if (desc.valueType === "number") return "number";
  if (desc.valueType === "string" && desc.options && desc.options.length > 0) return "select";
  return "text";
}

// ============================================================================
// Grouping
// ============================================================================

function buildGroups(descriptors: readonly KnobDescriptor[]): {
  groups: readonly KnobGroup[];
  hasInlineKnobs: boolean;
} {
  const ungrouped: KnobInfo[] = [];
  const grouped = new Map<string, KnobInfo[]>();
  let hasInlineKnobs = false;

  for (const desc of descriptors) {
    if (desc.inline === true) {
      hasInlineKnobs = true;
      continue;
    }
    const info: KnobInfo = { ...desc, semanticType: inferSemanticType(desc) };
    if (desc.group) {
      const list = grouped.get(desc.group);
      if (list) list.push(info);
      else grouped.set(desc.group, [info]);
    } else {
      ungrouped.push(info);
    }
  }

  const groups: KnobGroup[] = [];
  if (ungrouped.length > 0) groups.push({ name: "", knobs: ungrouped });
  for (const [name, knobs] of grouped) groups.push({ name, knobs });
  return { groups, hasInlineKnobs };
}

// ============================================================================
// Model-facing formatter
// ============================================================================

function formatValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function formatKnobLine(knob: KnobInfo): string {
  const typeLabel = knob.momentary ? `momentary ${knob.semanticType}` : knob.semanticType;
  const head = `${knob.id} [${typeLabel}]: ${formatValue(knob.value)}${
    knob.description ? ` — ${knob.description}` : ""
  }`;
  const hints: string[] = [];
  if (knob.options && knob.options.length > 0) {
    hints.push(`options: ${knob.options.map(formatValue).join(", ")}`);
  }
  if (knob.min !== undefined || knob.max !== undefined) {
    hints.push(`${knob.min ?? "*"} - ${knob.max ?? "*"}`);
  }
  if (knob.step !== undefined) hints.push(`step ${knob.step}`);
  if (knob.maxLength !== undefined) hints.push(`max ${knob.maxLength} chars`);
  if (knob.pattern !== undefined) hints.push(`pattern: ${knob.pattern}`);
  if (knob.required) hints.push("required");
  if (knob.momentary) hints.push("resets after use");
  if (knob.readOnly) hints.push("read-only");
  return hints.length > 0 ? `${head} (${hints.join(", ")})` : head;
}

function formatKnobsForModel(groups: readonly KnobGroup[], hasInlineKnobs: boolean): string {
  const lines: string[] = [
    "Knobs are adjustable parameters you can modify using the knob_set tool.",
    "",
  ];
  let first = true;
  for (const group of groups) {
    if (group.name === "") {
      for (const k of group.knobs) lines.push(formatKnobLine(k));
    } else {
      if (!first || lines.length > 2) lines.push("");
      lines.push(`### ${group.name}`);
      for (const k of group.knobs) lines.push(formatKnobLine(k));
    }
    first = false;
  }
  if (hasInlineKnobs) {
    lines.push("");
    lines.push(
      "Inline knobs (e.g., per-message collapse state) are not listed here. " +
        "Set them by name when needed.",
    );
  }
  return lines.join("\n").trimEnd();
}

// ============================================================================
// knob_set — input type re-exported from spec
// ============================================================================
//
// The validation pipeline + dispatch live on `KnobsHarness.dispatch(...)`
// (in `@agentick/knobs`). The knob_set tool below just forwards the
// validated input to the harness; no duplicate validation logic here.

export type KnobSetInput = KnobsDispatchInput;

// ============================================================================
// knob_set input schema (hand-rolled Standard Schema validator)
// ============================================================================

const knobSetSchema = jsonSchema<KnobSetInput>(
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the knob to set (mutually exclusive with group)",
      },
      group: {
        type: "string",
        description: "Group name — sets all knobs in the group (mutually exclusive with name)",
      },
      value: {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        description: "New value for the knob(s)",
      },
    },
    required: ["value"],
    additionalProperties: false,
  },
  {
    vendor: "agentick-knobs",
    validator: (raw) => {
      if (raw === null || typeof raw !== "object") {
        return { issues: [{ message: "knob_set input must be an object" }] };
      }
      const input = raw as Record<string, unknown>;
      const name = input.name;
      const group = input.group;
      const value = input.value;
      const issues: { message: string; path?: PropertyKey[] }[] = [];
      if (name !== undefined && typeof name !== "string") {
        issues.push({ message: "name must be a string", path: ["name"] });
      }
      if (group !== undefined && typeof group !== "string") {
        issues.push({ message: "group must be a string", path: ["group"] });
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        issues.push({ message: "value must be string, number, or boolean", path: ["value"] });
      }
      if (issues.length > 0) return { issues };
      return {
        value: {
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof group === "string" ? { group } : {}),
          value: value as KnobPrimitive,
        },
      };
    },
  },
);

const KnobSetTool = createTool({
  name: "knob_set",
  description:
    "Set a knob value by name, or set every knob in a group at once. " +
    "Provide either name or group, not both. " +
    "Use this to adjust agent behavior knobs surfaced in the Knobs section.",
  inputSchema: knobSetSchema,
  // TODO(tools-sweep / three-audiences-plan §D delta 3): normalize this
  // onto the ctx-slot rule (`ctx.knobs`, dispatch-resolved) like every
  // other harness tool, and drop this `use:` render-capture. BLOCKED on
  // the augmented-ctx-slot population seam not reaching knobs: the
  // `ctxExtensions` record is filled at the AppHarness single site
  // (`app/src/harness.ts` ~L1908) by pulling namespaces from
  // `sessionExtensionBridges`, but the knobs harness is NOT in that bag —
  // it's a core session bridge constructed inside `buildSessionBridges`
  // (`session/src/session-bridges.ts` L221) AFTER the ToolExecutor is
  // built, and it is instance-coupled to `GatesHarness` (same L317) and
  // interceptor-parented to the SessionHarness (session-bridges.ts
  // L193-199), which does not exist at the hoist site. `withKnobs` (the
  // would-be extension-bridge path) is dormant (extension.ts L9-14, Step 8
  // pending). Riding the seam requires hoisting knobs construction to the
  // single site (mirroring resources #159) AND re-homing its interceptor
  // parent — a shared-construction refactor, deferred per the §D discovery
  // stop rule. Until then this tool keeps the render-capture.
  use: () => {
    const { knobs } = useBridges();
    return { knobs };
  },
  // Delegate validation + mutation to the harness. The harness's
  // dispatch() runs the same pipeline the v1 knob_set tool ran,
  // emits Operation envelopes for audit, and returns the same
  // ContentBlock[] (success message or error blocks).
  handler: async (input, { use }) => use.knobs.dispatch(input),
});

// ============================================================================
// Bridge subscription hook
// ============================================================================

function useKnobsSnapshot(): {
  readonly descriptors: readonly KnobDescriptor[];
  readonly groups: readonly KnobGroup[];
  readonly hasInlineKnobs: boolean;
} {
  const { knobs } = useBridges();
  const subscribe = React.useCallback(
    (listener: () => void) => knobs.subscribeAll(listener),
    [knobs],
  );
  // The bridge guarantees `list()` returns the same reference between
  // mutations (cache invalidated on register/set). No client-side
  // caching needed.
  const getSnapshot = React.useCallback(() => knobs.list(), [knobs]);
  const descriptors = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const { groups, hasInlineKnobs } = buildGroups(descriptors);
    return { descriptors, groups, hasInlineKnobs };
  }, [descriptors]);
}

// ============================================================================
// <Knobs />
// ============================================================================

interface KnobsComponent extends React.FC<KnobsProps> {
  Provider: React.FC<{ children: React.ReactNode }>;
  Controls: React.FC<KnobsControlsProps>;
}

function KnobsImpl(props: KnobsProps): React.ReactElement | null {
  const { descriptors, groups, hasInlineKnobs } = useKnobsSnapshot();

  if (descriptors.length === 0) return null;

  if (typeof props.children === "function") {
    return h(React.Fragment, null, h(KnobSetTool.Tool, null), props.children(groups));
  }

  return h(
    React.Fragment,
    null,
    h(KnobSetTool.Tool, null),
    h(Section, { id: "knobs", title: "Knobs" }, formatKnobsForModel(groups, hasInlineKnobs)),
  );
}

// ============================================================================
// <Knobs.Provider>
// ============================================================================

function KnobsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { descriptors, groups, hasInlineKnobs } = useKnobsSnapshot();

  const contextValue = useMemo((): KnobsContextValue => {
    const knobs = groups.flatMap((g) => g.knobs);
    return {
      knobs,
      groups,
      hasInlineKnobs,
      get: (id) => knobs.find((k) => k.id === id),
    };
  }, [groups, hasInlineKnobs]);

  // Tool registers even when zero knobs — provider mode is "explicit
  // opt-in" and adopters expect the tool surface to be available.
  return h(
    React.Fragment,
    null,
    h(KnobSetTool.Tool, null),
    descriptors.length === 0
      ? children
      : h(KnobsContext.Provider, { value: contextValue }, children),
  );
}

// ============================================================================
// <Knobs.Controls>
// ============================================================================

interface KnobsControlsProps {
  readonly renderKnob?: (knob: KnobInfo) => React.ReactNode;
  readonly renderGroup?: (group: KnobGroup) => React.ReactNode;
}

function KnobsControls(props: KnobsControlsProps): React.ReactElement | null {
  const ctx = useContext(KnobsContext);
  if (!ctx) return null;

  if (props.renderGroup) {
    return h(React.Fragment, null, ...ctx.groups.map((g) => props.renderGroup!(g)));
  }
  if (props.renderKnob) {
    return h(React.Fragment, null, ...ctx.knobs.map((k) => props.renderKnob!(k)));
  }
  // Default rendering when no render prop is supplied.
  return h(
    Section,
    { id: "knobs", title: "Knobs" },
    formatKnobsForModel(ctx.groups, ctx.hasInlineKnobs),
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useKnobsContext(): KnobsContextValue {
  const ctx = useContext(KnobsContext);
  if (!ctx) throw new Error("useKnobsContext must be used inside <Knobs.Provider>");
  return ctx;
}

export function useKnobsContextOptional(): KnobsContextValue | null {
  return useContext(KnobsContext);
}

// ============================================================================
// Export
// ============================================================================

export const Knobs: KnobsComponent = Object.assign(KnobsImpl, {
  Provider: KnobsProvider,
  Controls: KnobsControls,
});
