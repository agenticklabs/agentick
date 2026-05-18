/**
 * `@agentick/app` — reference app harness.
 *
 * The outermost runtime boundary. Wraps the shared substrate, shared
 * sub-harnesses (reconciler, loop, executor), and the session registry
 * behind the ergonomic `createApp(...)` surface.
 *
 * @see docs/proposals/v2/blueprint/09-app-harness.md
 */

export { AppHarness, type AppHarnessOptions } from "./harness.js";
export { createApp } from "./create-app.js";

// `defineApp` is the naming-consistent twin of `createApp` — same
// function, exported under both names so users can choose the verb
// that matches their mental model (factory vs. builder).
export { createApp as defineApp } from "./create-app.js";
