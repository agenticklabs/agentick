/**
 * The create-time shape an adopter fills — shared by `<Sandbox>` (render) and
 * `withSandbox`/`defineSandbox` (config). Both turn it into a
 * {@link SandboxCreateOptions} for the provider and split the ACL out for the
 * permission gate, so the mapping has one home.
 */

import type { SandboxACL, SandboxPermissions } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import type { SandboxCreateOptions } from "./contract.js";

export interface SandboxShape {
  readonly workspace?: SandboxCreateOptions["workspace"];
  readonly mounts?: SandboxCreateOptions["mounts"];
  readonly mountAllow?: SandboxCreateOptions["mountAllow"];
  readonly allow?: SandboxACL & SandboxPermissions;
  readonly env?: SandboxCreateOptions["env"];
  readonly limits?: SandboxCreateOptions["limits"];
  readonly setup?: SandboxCreateOptions["setup"];
}

export function toCreateOptions(shape: SandboxShape): SandboxCreateOptions {
  return omitUndefined({
    workspace: shape.workspace,
    mounts: shape.mounts,
    mountAllow: shape.mountAllow,
    allow: shape.allow,
    env: shape.env,
    limits: shape.limits,
    setup: shape.setup,
  });
}

export function aclOf(allow: SandboxShape["allow"]): SandboxACL | undefined {
  if (allow === undefined) return undefined;
  const acl: SandboxACL = omitUndefined({
    read: allow.read,
    write: allow.write,
    exec: allow.exec,
    network: allow.network,
  });
  return Object.keys(acl).length > 0 ? acl : undefined;
}
