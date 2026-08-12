/**
 * `defineSandbox()` — the local placement, provider baked.
 *
 * The `@agentick/app/react` move across a package boundary: importing from here
 * IS the placement choice (local), so a bare `defineSandbox()` needs no
 * provider argument. Options are FLAT — the local provider's own config
 * (`strategy`, `network`, `tmpBase`, `cleanupWorkspace`) alongside the generic
 * sandbox definition fields (`allow`, `workspace`, `mounts`, …) in one bag.
 *
 * Adopters who want to compose at a coarser granularity import the generic
 * `defineSandbox` from `@agentick/sandbox` and pass `localProvider()` explicitly.
 *
 * @see docs/proposals/v2/code-runtime-composition.md §"granularity by import"
 */

import { defineSandbox as defineSandboxBase, type SandboxDefinition } from "@agentick/sandbox";
import { omitUndefined } from "@agentick/utils";

import { localProvider, type LocalProviderConfig } from "./provider.js";

export interface LocalSandboxOptions
  extends LocalProviderConfig, Omit<SandboxDefinition, "provider"> {}

export function defineSandbox(options: LocalSandboxOptions = {}): SandboxDefinition {
  const { strategy, network, tmpBase, cleanupWorkspace, ...definition } = options;
  return defineSandboxBase({
    ...definition,
    provider: localProvider(omitUndefined({ strategy, network, tmpBase, cleanupWorkspace })),
  });
}
