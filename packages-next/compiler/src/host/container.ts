/**
 * CompilerContainer — the root of one host tree.
 *
 * One container per active mount. Carries the root scope (passed in at
 * mount time and used by `getRootHostContext`) and the ordered list of
 * top-level children.
 *
 * Containers are private to the compiler harness — they never cross
 * the spec firewall.
 */

import type { HostScope } from "./host-context.js";
import { rootScope as defaultRootScope } from "./host-context.js";
import type { HostInstance } from "./host-instance.js";

export interface CompilerContainer {
  /** Stable identifier for the mount — `MountInput.mountId`. */
  readonly mountId: string;

  /**
   * `HostScope` returned from `getRootHostContext`. Children at the
   * top of the tree inherit from this; nested scopes are derived via
   * `getChildHostContext`.
   */
  rootScope: HostScope;

  /** Top-level host instances. Mutated by host-config tree-mutation methods. */
  readonly children: HostInstance[];
}

export interface CreateContainerInput {
  readonly mountId: string;
  readonly rootScope?: HostScope;
}

/**
 * Construct a fresh container. The `rootScope` defaults to the
 * library-level `defaultRootScope` (formatter id `"default"`, empty
 * path) but mounts SHOULD supply their own root scope reflecting the
 * caller-chosen default formatter.
 */
export function createContainer(input: CreateContainerInput): CompilerContainer {
  return {
    mountId: input.mountId,
    rootScope: input.rootScope ?? defaultRootScope,
    children: [],
  };
}
