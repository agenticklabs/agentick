/**
 * `@agentick/sandbox-edit-next` — the pure, OS-free surgical edit transform.
 *
 * The crown-jewel layered-matching editor (`applyEdits`) extracted to a
 * shared package so the sandbox harness (`@agentick/sandbox-next`) and
 * every provider (`sandbox-local-next`, `sandbox-docker-next`) consume
 * one implementation. Providers depend on `spec-next` + this package
 * only — never on the harness package (ADR 59, Wave 2).
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export { applyEdits, EditError } from "./edit.js";
