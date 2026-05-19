/**
 * Collector — host tree → RenderedTree.
 *
 * Layer B of the reconciler harness. Walks the host tree, dispatches
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
  ContextEntry,
  FormatDiagnostic,
  FormatPurpose,
  FormatterRef,
  MCPDeclaration,
  OutputDeclaration,
  ProviderOptions,
  RenderedTree,
  ResourceDeclaration,
  SemanticContentBlock,
  SemanticNode,
  SpecConfig,
  SpecFeatureName,
  ToolDeclaration,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import {
  resolveFormatter,
  withFormatter,
  type FormatterBinding,
  type HostScope,
} from "../host/host-context.js";
import {
  isElementInstance,
  isTextInstance,
  type ElementInstance,
  type HostInstance,
} from "../host/host-instance.js";
import type { CollectContext } from "./contributor.js";
import type { IRFragment } from "./fragments.js";
import { ContributorRegistry } from "./registry.js";

export interface CollectInput {
  /** Root host children to walk. Usually the container's children. */
  readonly roots: readonly HostInstance[];
  /** Registry of contributors. Built-in registry + caller registrations. */
  readonly registry: ContributorRegistry;
  /** Default formatter when contributors don't pin one. */
  readonly rootScope: HostScope;
}

export interface CollectResult {
  readonly tree: RenderedTree;
  readonly diagnostics: readonly FormatDiagnostic[];
}

/**
 * Walk the host tree and produce a `RenderedTree`.
 */
export function collect(input: CollectInput): CollectResult {
  const { roots, registry, rootScope } = input;

  const allFragments: IRFragment[] = [];
  const ctxFactory = makeContextFactory(registry, rootScope);

  for (const root of roots) {
    for (const frag of ctxFactory(rootScope).walk(root)) {
      allFragments.push(frag);
    }
  }

  return foldFragments(allFragments);
}

// ============================================================================
// Context factory — produces a CollectContext bound to a given scope.
// ============================================================================

function makeContextFactory(
  registry: ContributorRegistry,
  rootScope: HostScope,
): (scope: HostScope) => CollectContext {
  function make(scope: HostScope): CollectContext {
    return {
      scope,

      walk(child: HostInstance): readonly IRFragment[] {
        return walkInstance(child, scope);
      },

      collectContentBlocks(
        parent: HostInstance,
        outbound?: IRFragment[],
      ): readonly ContentBlock[] {
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

    type Item =
      | { readonly kind: "text"; readonly value: string }
      | { readonly kind: "semantic"; readonly value: SemanticNode }
      | { readonly kind: "block"; readonly value: SemanticContentBlock };

    const items: Item[] = [];
    gatherItems(parent, scope, outbound, items);
    return coalesce(items);
  }

  function gatherItems(
    parent: HostInstance,
    scope: HostScope,
    outbound: IRFragment[] | undefined,
    items: Array<
      | { readonly kind: "text"; readonly value: string }
      | { readonly kind: "semantic"; readonly value: SemanticNode }
      | { readonly kind: "block"; readonly value: SemanticContentBlock }
    >,
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
        } else if (f.kind === "diagnostic" && outbound) {
          outbound.push(f);
        }
      }
    }
  }

  function coalesce(
    items: ReadonlyArray<
      | { readonly kind: "text"; readonly value: string }
      | { readonly kind: "semantic"; readonly value: SemanticNode }
      | { readonly kind: "block"; readonly value: SemanticContentBlock }
    >,
  ): readonly SemanticContentBlock[] {
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

function foldFragments(fragments: readonly IRFragment[]): CollectResult {
  const entries: ContextEntry[] = [];
  const tools: ToolDeclaration[] = [];
  const resources: ResourceDeclaration[] = [];
  const outputs: OutputDeclaration[] = [];
  const mcps: MCPDeclaration[] = [];
  const freeRootBlocks: ContentBlock[] = [];
  const diagnostics: FormatDiagnostic[] = [];
  const metadata: Record<string, unknown> = {};
  let specConfig: SpecConfig | undefined;
  let providerOptions: ProviderOptions | undefined;

  for (const frag of fragments) {
    switch (frag.kind) {
      case "context-entry":
        entries.push(frag.entry as ContextEntry);
        break;
      case "tool-declaration":
        tools.push(frag.tool);
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
    ...(tools.length || resources.length || outputs.length || mcps.length
      ? {
          declarations: {
            ...(tools.length ? { tools } : {}),
            ...(resources.length ? { resources } : {}),
            ...(outputs.length ? { outputs } : {}),
            ...(mcps.length ? { mcp: mcps } : {}),
          },
        }
      : {}),
    ...(specConfig ? { config: specConfig } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(freeRootBlocks.length ? { content: freeRootBlocks } : {}),
    ...(diagnostics.length ? { diagnostics: { diagnostics } } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };

  return { tree, diagnostics };
}

function mergeProviderOptions(
  existing: ProviderOptions | undefined,
  patch: ProviderOptions,
): ProviderOptions {
  if (!existing) return { ...patch };
  const out: ProviderOptions = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = { ...(out[k] ?? {}), ...v };
  }
  return out;
}

function computeFeatures(input: {
  readonly entries: readonly ContextEntry[];
  readonly tools: readonly ToolDeclaration[];
  readonly outputs: readonly OutputDeclaration[];
  readonly mcps: readonly MCPDeclaration[];
  readonly providerOptions: ProviderOptions | undefined;
  readonly freeRootBlocks: readonly ContentBlock[];
}): readonly SpecFeatureName[] {
  const features: SpecFeatureName[] = [];
  if (input.entries.some((e) => e.kind === "section")) features.push("sections");
  if (input.tools.length > 0) features.push("tool-declarations");
  if (input.providerOptions) features.push("provider-options");
  if (input.freeRootBlocks.length > 0) features.push("free-root-content");
  if (input.outputs.length > 0) features.push("outputs");
  if (input.mcps.length > 0) features.push("mcp-declarations");
  return features;
}
