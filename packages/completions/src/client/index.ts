/**
 * `@agentick/completions/client` — the browser-safe surface.
 *
 * Completions deliberately ships NO client handle: a completion query is
 * ephemeral, so there is no state for a handle to hold, and the derived
 * wire-namespace proxy mints `session.completions.complete(...)` from the
 * `WireMethods` row alone. What a browser consumer DOES need is that row's
 * type — and importing the main barrel for it would pull the harness runtime
 * (`@agentick/runtime`, effect) into the type graph for one 8-line
 * augmentation. This subpath is the row, and only the row, plus the result
 * currency to name the answer.
 *
 * Mirrors the `/client` convention prompts / skills / timeline follow: a
 * harness package MAY add a client surface that never loads the server
 * harness.
 */

// Type-only side effect: makes `completions/complete` a valid `WireMethods`
// row — which is ALSO what mints the typed `session.completions.complete(...)`
// on the derived session proxy. Zero runtime.
import "../wire-augment.js";

// The answer's shape, re-exported so a browser consumer can name it without
// touching the server barrel.
export type { CompletionResult, CompletionValues } from "@agentick/spec";
