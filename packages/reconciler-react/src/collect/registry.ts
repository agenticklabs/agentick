/**
 * ContributorRegistry — type-keyed lookup for the collector.
 *
 * Built-in registrations live in `built-ins.ts`. Users register
 * additional contributors via `harness.registerContributor(...)` (added
 * in Phase 3.10).
 */

import type { Contributor } from "./contributor.js";
import type { HostType } from "../host/host-instance.js";

export class ContributorRegistry {
  private byType = new Map<HostType, Contributor>();

  register(contributor: Contributor): void {
    if (this.byType.has(contributor.type)) {
      throw new Error(
        `ContributorRegistry: duplicate contributor for ${describeType(contributor.type)}`,
      );
    }
    this.byType.set(contributor.type, contributor);
  }

  /** Replace an existing contributor (or register a fresh one). */
  override(contributor: Contributor): void {
    this.byType.set(contributor.type, contributor);
  }

  lookup(type: HostType): Contributor | undefined {
    return this.byType.get(type);
  }

  has(type: HostType): boolean {
    return this.byType.has(type);
  }

  /** Number of registered contributors. Useful for diagnostics. */
  size(): number {
    return this.byType.size;
  }
}

function describeType(type: HostType): string {
  if (typeof type === "string") return `intrinsic <${type}>`;
  if (typeof type === "symbol") return type.toString();
  if (typeof type === "function") return `component ${type.name || "(anonymous)"}`;
  return "<unknown>";
}
