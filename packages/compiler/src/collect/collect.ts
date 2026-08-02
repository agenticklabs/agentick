/**
 * Collector — host tree → RenderedTree.
 *
 * Layer B of the compiler harness. Walks the host tree, dispatches
 * each element instance to a Contributor by component identity, and
 * folds the resulting `IRFragment`s into a single `RenderedTree`.
 *
 * The walker is small (the file is short on purpose). Per-primitive
 * logic lives in `contributors/`. Adding a new primitive does NOT
 * touch this file.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer B
 */

import type {
  ContentBlock,
  FormatDiagnostic,
  FormatPurpose,
  FormatterRef,
  MCPDeclaration,
  MessageEntry,
  ModelDeclaration,
  OutputDeclaration,
  ProviderOptions,
  ProviderToolDeclaration,
  RenderedTree,
  ResourceDeclaration,
  SemanticContentBlock,
  SemanticNode,
  SpecConfig,
  SpecFeatureName,
  SurfacingProvenance,
  ToolDeclaration,
} from "@agentick/spec";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec";

import {
  resolveFormatter,
  withFormatter,
  type FormatterBinding,
  type HostScope,
} from "../host/host-context.js";
import { isElementInstance, isTextInstance, type HostInstance } from "../host/host-instance.js";
import type { CollectContext } from "./contributor.js";
import type { IRFragment } from "./fragments.js";
import { ContributorRegistry } from "./registry.js";
import {
  builtInDefaultProjections,
  type DefaultProjection,
  type ProjectionSources,
} from "./projection.js";

/** One contribution inside a content container, before coalescing. */
type Item =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "semantic"; readonly value: SemanticNode }
  | { readonly kind: "block"; readonly value: SemanticContentBlock };

export interface CollectInput {
  /** Root host children to walk. Usually the container's children. */
  readonly roots: readonly HostInstance[];
  /** Registry of contributors. Built-in registry + caller registrations. */
  readonly registry: ContributorRegistry;
  /** Default formatter when contributors don't pin one. */
  readonly rootScope: HostScope;
  /**
   * Surfacing default projections (ADR 63). Each runs LAZILY — only when
   * the tree did not override its `key`. Defaults to
   * {@link builtInDefaultProjections} (the compiler-agnostic `tools`
   * default) so tools surface with zero configuration; the compiler
   * binding passes an augmented list that also folds the timeline.
   */
  readonly defaults?: readonly DefaultProjection[];
}

export interface CollectResult {
  readonly tree: RenderedTree;
  readonly diagnostics: readonly FormatDiagnostic[];
}

/**
 * The old `<Section>rules</Section><Timeline />` shape no longer produces a
 * system prompt — a tree with no `<System>` sends no system instructions.
 * The fix is one wrapper, so the diagnostic names it. A migration hint, not
 * a compatibility shim: nothing is folded back.
 */
const BARE_LEADING_SECTION: FormatDiagnostic = {
  severity: "warning",
  code: "SECTION_WITHOUT_SYSTEM",
  message:
    "A <Section> before any message compiles to a `grounding` message at that position, " +
    "NOT to the system prompt. If these are system instructions, wrap it in <System>. " +
    "(ADR 94 — container decides role, position decides order.)",
};

/**
 * A `role` on a section INSIDE a message. The prop only means anything for
 * the anonymous message a free-standing section becomes; here the container
 * has already decided the role, so honouring it would need the section to
 * break out of its parent — which is the hoisting ADR 94 removed. Reported
 * rather than ignored, because a silently-dropped prop reads as a bug in the
 * framework rather than in the tree.
 */
function sectionRoleInMessage(role: string): FormatDiagnostic {
  return {
    severity: "warning",
    code: "SECTION_ROLE_IN_MESSAGE",
    message:
      `<Section role="${role}"> is nested inside a message, where the container already ` +
      "decides the role — the prop is ignored. It applies only to a free-standing section, " +
      `whose anonymous message it names. To emit a ${role} message, write <Message ` +
      `role="${role}"> around this section instead.`,
  };
}

/**
 * Never mid-stream system. Enforced at compile time rather than by silently
 * hoisting the message to the front, which is the defect ADR 94 removes.
 */
const MID_STREAM_SYSTEM: FormatDiagnostic = {
  severity: "warning",
  code: "MID_STREAM_SYSTEM",
  message:
    "A <System> message appears at or after the first non-system message. System " +
    "instructions have no mid-conversation position: leading <System> messages merge " +
    "into the provider's system parameter, and this one will be merged with them out of " +
    "tree order. Move it to the top, or use <Grounding> for mid-stream context.",
};

/**
 * Walk the host tree and produce a `RenderedTree`.
 */
export function collect(input: CollectInput): CollectResult {
  const { roots, registry, rootScope } = input;
  const defaults = input.defaults ?? builtInDefaultProjections;

  const allFragments: IRFragment[] = [];
  const ctxFactory = makeContextFactory(registry, rootScope);

  for (const root of roots) {
    for (const frag of ctxFactory(rootScope).walk(root)) {
      allFragments.push(frag);
    }
  }

  return foldFragments(allFragments, defaults);
}

// ============================================================================
// Context factory — produces a CollectContext bound to a given scope.
// ============================================================================

function makeContextFactory(
  registry: ContributorRegistry,
  _rootScope: HostScope,
): (scope: HostScope) => CollectContext {
  function make(scope: HostScope): CollectContext {
    return {
      scope,

      walk(child: HostInstance): readonly IRFragment[] {
        return walkInstance(child, scope);
      },

      collectContentBlocks(parent: HostInstance, outbound?: IRFragment[]): readonly ContentBlock[] {
        return foldContentBlocks(parent, scope, outbound);
      },

      collectText(parent: HostInstance): string {
        return foldText(parent);
      },

      stableId(prefix: string, instance: HostInstance): string {
        return `${prefix}.${instance.hostId}`;
      },

      formatter(purpose?: FormatPurpose): FormatterRef {
        return resolveFormatter(scope, purpose);
      },
    };
  }

  function walkInstance(instance: HostInstance, scope: HostScope): readonly IRFragment[] {
    if (isTextInstance(instance)) {
      // Text instances at the top of the tree become free-root content;
      // text instances inside section/message are folded by their parent.
      if (instance.text.length === 0) return [];
      const block: ContentBlock = { type: "text", text: instance.text };
      return [{ kind: "free-root-content", blocks: [block] }];
    }

    // The `format` intrinsic is the canonical formatter-scope provider.
    // It pushes a new HostScope for its subtree and contributes nothing
    // itself. <Markdown> / <XML> / user-defined components are React
    // function-component wrappers that render to `<format formatter={...}>`.
    if (instance.type === "format") {
      const nextScope = deriveFormatScope(instance, scope);
      const out: IRFragment[] = [];
      for (const child of instance.children) {
        for (const frag of walkInstance(child, nextScope)) out.push(frag);
      }
      return out;
    }

    const contributor = registry.lookup(instance.type);
    if (!contributor) {
      // No contributor — passthrough: walk children and pool their
      // contributions. This handles Fragment naturally and lets
      // unknown wrapper components compose transparently.
      const out: IRFragment[] = [];
      for (const child of instance.children) {
        for (const frag of walkInstance(child, scope)) out.push(frag);
      }
      return out;
    }

    return contributor.contribute(instance, make(scope));
  }

  /**
   * Walk a content-container's children and assemble its
   * `ContentBlock[]`. Inline grouping rule (ADR 22 §D5):
   *
   *   - Contiguous text + semantic-node fragments coalesce into ONE
   *     TextBlock. If any semantic-node appeared in the run, the
   *     resulting TextBlock carries a `semanticNode` sidecar tree;
   *     otherwise the TextBlock is a plain `{ text: "..." }`.
   *   - Native ContentBlock fragments (Image, CodeBlock, JsonBlock, …)
   *     break the run — they're their own block.
   *
   * The walker does NOT distinguish inline vs block semantic elements;
   * spacing and layout are the formatter's responsibility.
   *
   * The result type is `SemanticContentBlock[]` because TextBlocks may
   * carry sidecars. The harness's post-collect formatter pass consumes
   * the sidecars and replaces these with wire-shape `ContentBlock[]`.
   */
  function foldContentBlocks(
    parent: HostInstance,
    scope: HostScope,
    outbound?: IRFragment[],
  ): readonly SemanticContentBlock[] {
    if (!isElementInstance(parent)) return [];

    const items: Item[] = [];
    gatherItems(parent, scope, outbound, items);
    return coalesce(items);
  }

  function gatherItems(
    parent: HostInstance,
    scope: HostScope,
    outbound: IRFragment[] | undefined,
    items: Item[],
  ): void {
    if (!isElementInstance(parent)) return;
    for (const child of parent.children) {
      if (isTextInstance(child)) {
        if (child.text.length > 0) items.push({ kind: "text", value: child.text });
        continue;
      }
      // `<format>` scopes its descendants' formatter but contributes no
      // fragment itself — recurse with the new scope.
      if (child.kind === "element" && child.type === "format") {
        const nextScope = deriveFormatScope(child, scope);
        gatherItems(child, nextScope, outbound, items);
        continue;
      }
      const contributor = registry.lookup(child.type);
      if (!contributor) {
        // Wrapper component without a contributor — fold children.
        gatherItems(child, scope, outbound, items);
        continue;
      }
      const frags = contributor.contribute(child, make(scope));
      for (const f of frags) {
        if (f.kind === "content-block") {
          items.push({ kind: "block", value: f.block });
        } else if (f.kind === "semantic-node") {
          items.push({ kind: "semantic", value: f.node });
        } else if (f.kind === "section-content") {
          // THE next.17 FIX. A `<section>` nested in a `<message>` used to
          // fall off this switch — its fragment was neither a content-block
          // nor a semantic-node, so the section (and everything in it)
          // vanished from the compiled context with no diagnostic. It now
          // splices into the containing message's content, whatever the
          // message's role (ADR 94).
          if (f.role !== undefined && outbound) {
            outbound.push({ kind: "diagnostic", diagnostic: sectionRoleInMessage(f.role) });
          }
          for (const b of f.blocks) items.push({ kind: "block", value: b });
        } else if (f.kind === "diagnostic" && outbound) {
          outbound.push(f);
        }
      }
    }
  }

  function coalesce(items: readonly Item[]): readonly SemanticContentBlock[] {
    const result: SemanticContentBlock[] = [];
    let runText: string[] = [];
    let runSem: SemanticNode[] = [];
    let hasSemantic = false;

    const flush = (): void => {
      if (hasSemantic) {
        // Convert any tailing plain text into semantic leaves
        for (const t of runText) runSem.push({ text: t });
        result.push({
          type: "text",
          text: "",
          semanticNode: { children: runSem },
        } as SemanticContentBlock);
      } else if (runText.length > 0) {
        result.push({ type: "text", text: runText.join("") });
      }
      runText = [];
      runSem = [];
      hasSemantic = false;
    };

    for (const item of items) {
      if (item.kind === "text") {
        if (hasSemantic) {
          runSem.push({ text: item.value });
        } else {
          runText.push(item.value);
        }
      } else if (item.kind === "semantic") {
        if (!hasSemantic) {
          // Promote any accumulated plain text to semantic leaves.
          for (const t of runText) runSem.push({ text: t });
          runText = [];
          hasSemantic = true;
        }
        runSem.push(item.value);
      } else {
        // Native ContentBlock breaks the run.
        flush();
        result.push(item.value);
      }
    }
    flush();
    return result;
  }

  function foldText(parent: HostInstance): string {
    if (!isElementInstance(parent)) return "";
    const parts: string[] = [];
    walkText(parent, parts);
    return parts.join("");
  }

  function walkText(instance: HostInstance, out: string[]): void {
    if (isTextInstance(instance)) {
      if (instance.text.length > 0) out.push(instance.text);
      return;
    }
    for (const child of instance.children) walkText(child, out);
  }

  return make;
}

/**
 * Derive a new HostScope from a `<format>` intrinsic's props.
 *
 * Shape:
 *   <format formatter={ref} purpose?={purpose}>
 *
 * - `formatter` (required) — the FormatterRef to bind.
 * - `purpose` (optional) — when set, scope only that purpose
 *   (e.g., `"section"` → only section content uses the new formatter;
 *   messages keep the parent's default). When absent, the formatter
 *   replaces the scope's default.
 *
 * Invalid / missing `formatter` props are silently passed through with
 * the parent scope. Diagnostics for malformed `<format>` use can be
 * added later via the diagnostic stream — kept lenient for now so the
 * walker never fails on user-error.
 */
function deriveFormatScope(
  instance: { props: Readonly<Record<string, unknown>> },
  parent: HostScope,
): HostScope {
  const props = instance.props as {
    readonly formatter?: { readonly id: string };
    readonly purpose?: FormatPurpose;
  };
  if (!props.formatter || typeof props.formatter !== "object" || !props.formatter.id) {
    return parent;
  }
  const binding: FormatterBinding = props.purpose
    ? { formatter: props.formatter, purpose: props.purpose }
    : { formatter: props.formatter };
  return withFormatter(parent, binding);
}

// ============================================================================
// Fragment folder — assembles a RenderedTree from an IRFragment stream.
// ============================================================================

function foldFragments(
  fragments: readonly IRFragment[],
  defaults: readonly DefaultProjection[],
): CollectResult {
  // ── Surfacing accumulators (ADR 63) ──
  // `entries` is built with a parallel `entryProvenance` array; the two
  // grow together so indices stay aligned through to the sidecar.
  const entries: MessageEntry[] = [];
  const entryProvenance: SurfacingProvenance[] = [];
  const tools: ToolDeclaration[] = [];
  const toolProvenance: SurfacingProvenance[] = [];
  /** Accumulated tool SOURCES (each `<Tool>` registration) — the input a
   *  default `tools` projection advertises. NOT surfaced until a
   *  projection reads them. */
  const toolSources: ToolDeclaration[] = [];
  /** Keys a component overrode — suppresses that key's lazy default. */
  const overriddenKeys = new Set<string>();

  const resources: ResourceDeclaration[] = [];
  const outputs: OutputDeclaration[] = [];
  const mcps: MCPDeclaration[] = [];
  // Pass D: provider-EXECUTED tools. Concatenated in walk order; the
  // executor's `project` phase dedupes by provider + resolved name.
  const providerTools: ProviderToolDeclaration[] = [];
  // ADR 56: single tree-declared model per tick. Last-wins in walk order
  // (depth-first pre-order) → nearest-scope / last-wins when a tree nests
  // several `<model-declaration>`s.
  let model: ModelDeclaration | undefined;
  const freeRootBlocks: ContentBlock[] = [];
  const diagnostics: FormatDiagnostic[] = [];
  const metadata: Record<string, unknown> = {};
  let specConfig: SpecConfig | undefined;
  let providerOptions: ProviderOptions | undefined;
  /** Has a non-system entry landed yet? Gates both ADR 94 diagnostics. */
  let sawNonSystem = false;
  let warnedBareSection = false;

  for (const frag of fragments) {
    switch (frag.kind) {
      case "context-entry": {
        // Raw content append stream — `<Message>` written directly in the
        // tree (not through a projection override).
        const entry = frag.entry;
        if (entry.role === "system") {
          if (sawNonSystem) diagnostics.push(MID_STREAM_SYSTEM);
        } else {
          sawNonSystem = true;
        }
        entries.push(entry);
        entryProvenance.push("authored:content");
        break;
      }
      case "section-content": {
        // The anonymous-box rule (CSS): content appearing where its kind
        // does not belong is wrapped in an anonymous container of the right
        // kind. A free-floating `<Section>` becomes a message AT ITS OWN
        // POSITION — the section below `<Timeline />` is the last message the
        // model receives (ADR 94).
        const role = frag.role ?? "grounding";
        if (role === "system") {
          // An explicitly system-roled section is a system entry like any
          // other, and answers to the same never-mid-stream rule.
          if (sawNonSystem) diagnostics.push(MID_STREAM_SYSTEM);
        } else {
          // Only the DEFAULT role earns the migration hint. `role` on the
          // section means the author chose this shape deliberately.
          if (
            frag.role === undefined &&
            !sawNonSystem &&
            !entries.some((e) => e.role === "system")
          ) {
            if (!warnedBareSection) diagnostics.push(BARE_LEADING_SECTION);
            warnedBareSection = true;
          }
          sawNonSystem = true;
        }
        entries.push({
          kind: "message",
          role,
          content: frag.blocks,
          id: frag.id,
          ...(frag.renderedWith ? { renderedWith: frag.renderedWith } : {}),
          ...(frag.metadata ? { metadata: frag.metadata } : {}),
        });
        entryProvenance.push("authored:content");
        break;
      }
      case "projection-override": {
        // A component overriding its harness's projection for `key`.
        // Suppresses that key's lazy default; its entries/tools land at
        // this tree position, tagged authored:<key>.
        overriddenKeys.add(frag.key);
        const prov: SurfacingProvenance = `authored:${frag.key}`;
        for (const e of frag.result.entries ?? []) {
          if (e.role === "system") {
            if (sawNonSystem) diagnostics.push(MID_STREAM_SYSTEM);
          } else {
            sawNonSystem = true;
          }
          entries.push(e);
          entryProvenance.push(prov);
        }
        for (const t of frag.result.tools ?? []) {
          tools.push(t);
          toolProvenance.push(prov);
        }
        break;
      }
      case "tool-declaration":
        // A tool SOURCE (registration), not a surfacing op. Surfaced by
        // the `tools` projection (default, or a `<Tools>` override).
        toolSources.push(frag.tool);
        break;
      case "provider-tool-declaration":
        providerTools.push(frag.providerTool);
        break;
      case "model-declaration":
        model = frag.model;
        break;
      case "resource-declaration":
        resources.push(frag.resource);
        break;
      case "output-declaration":
        outputs.push(frag.output);
        break;
      case "mcp-declaration":
        mcps.push(frag.mcp);
        break;
      case "free-root-content":
        for (const b of frag.blocks) freeRootBlocks.push(b);
        break;
      case "spec-config":
        specConfig = { ...(specConfig ?? {}), ...frag.partial };
        break;
      case "provider-options":
        providerOptions = mergeProviderOptions(providerOptions, frag.partial);
        break;
      case "diagnostic":
        diagnostics.push(frag.diagnostic);
        break;
      case "metadata":
        metadata[frag.key] = frag.value;
        break;
      case "content-block":
        // Content-block fragments only make sense inside a parent fold;
        // bare ones at the top level become free-root content.
        freeRootBlocks.push(frag.block);
        break;
    }
  }

  // ── Lazy default projections (ADR 63) ──
  // Each default runs ONLY when its key wasn't overridden by a component
  // (an overridden timeline is never folded). Default contributions are
  // appended AFTER the tree-order stream — they have no tree position —
  // and tagged default:<key>. They are real contributions the compiler
  // ran, not injection: the IR still contains only what the compiler
  // produced (ADR 49 preserved).
  const sources: ProjectionSources = { tools: toolSources };
  for (const def of defaults) {
    if (overriddenKeys.has(def.key)) continue;
    const result = def.project(sources);
    const prov: SurfacingProvenance = `default:${def.key}`;
    for (const e of result.entries ?? []) {
      entries.push(e);
      entryProvenance.push(prov);
    }
    for (const t of result.tools ?? []) {
      tools.push(t);
      toolProvenance.push(prov);
    }
  }

  const features = computeFeatures({
    entries,
    tools,
    outputs,
    mcps,
    providerOptions,
    freeRootBlocks,
  });

  const tree: RenderedTree = {
    specVersion: SPEC_VERSION,
    ...(features.length > 0 ? { features } : {}),
    context: { entries },
    ...(tools.length ||
    resources.length ||
    outputs.length ||
    mcps.length ||
    providerTools.length ||
    model
      ? {
          declarations: {
            ...(tools.length ? { tools } : {}),
            ...(resources.length ? { resources } : {}),
            ...(outputs.length ? { outputs } : {}),
            ...(mcps.length ? { mcp: mcps } : {}),
            ...(providerTools.length ? { providerTools } : {}),
            ...(model ? { model } : {}),
          },
        }
      : {}),
    ...(specConfig ? { config: specConfig } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(freeRootBlocks.length ? { content: freeRootBlocks } : {}),
    ...(diagnostics.length ? { diagnostics: { diagnostics } } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(entryProvenance.length || toolProvenance.length
      ? {
          provenance: {
            ...(entryProvenance.length ? { entries: entryProvenance } : {}),
            ...(toolProvenance.length ? { tools: toolProvenance } : {}),
          },
        }
      : {}),
  };

  return { tree, diagnostics };
}

function computeFeatures(input: {
  readonly entries: readonly MessageEntry[];
  readonly tools: readonly ToolDeclaration[];
  readonly outputs: readonly OutputDeclaration[];
  readonly mcps: readonly MCPDeclaration[];
  readonly providerOptions: ProviderOptions | undefined;
  readonly freeRootBlocks: readonly ContentBlock[];
}): readonly SpecFeatureName[] {
  const features: SpecFeatureName[] = [];
  if (input.entries.some((e) => e.role === "grounding")) features.push("sections");
  if (input.tools.length > 0) features.push("tool-declarations");
  if (input.providerOptions) features.push("provider-options");
  if (input.freeRootBlocks.length > 0) features.push("free-root-content");
  if (input.outputs.length > 0) features.push("outputs");
  if (input.mcps.length > 0) features.push("mcp-declarations");
  return features;
}
