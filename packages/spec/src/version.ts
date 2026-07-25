/**
 * Spec version — date-string identifier for the protocol contract.
 *
 * Distinct from package version (semver). The spec version changes when
 * the wire format itself evolves; the package version changes for any
 * release. Both are intentional axes per the date-versioned, additive
 * evolution discipline.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §Versioning
 */
export const SPEC_VERSION = "2026-05-08" as const;

export type SpecVersion = typeof SPEC_VERSION;
