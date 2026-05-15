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
  SpecConfig,
  SpecFeatureName,
  ToolDeclaration,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { resolveFormatter, type HostScope } from "../host/host-context.js";
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

      collectContentBlocks(parent: HostInstance): readonly ContentBlock[] {
        return foldContentBlocks(parent, scope);
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

  function foldContentBlocks(parent: HostInstance, scope: HostScope): readonly ContentBlock[] {
    if (!isElementInstance(parent)) return [];
    const blocks: ContentBlock[] = [];
    for (const child of parent.children) {
      if (isTextInstance(child)) {
        if (child.text.length > 0) blocks.push({ type: "text", text: child.text });
        continue;
      }
      // Recurse: a wrapper component (no contributor) folds children.
      // A contributor that produces content-block fragments contributes
      // them directly to this parent's content.
      const contributor = registry.lookup(child.type);
      if (!contributor) {
        for (const b of foldContentBlocks(child, scope)) blocks.push(b);
        continue;
      }
      // Content-block contributors return `content-block` fragments;
      // other contributors return non-content fragments which are not
      // appropriate as inline content. We append the content blocks and
      // ignore other fragment kinds at this fold level (they are
      // surfaced at the tree level via the main walk).
      const frags = contributor.contribute(child, make(scope));
      for (const f of frags) {
        if (f.kind === "content-block") blocks.push(f.block);
      }
    }
    return blocks;
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
