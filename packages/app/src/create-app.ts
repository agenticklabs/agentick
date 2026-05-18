/**
 * `createApp` — the user-facing factory. Returns an `AppHarness` after
 * awaiting the substrate readiness signals. This is the path most
 * applications use:
 *
 * ```ts
 * const app = await createApp(<MyAgent />, {
 *   executor: new OpenAIExecutor(...),
 *   target: { kind: "language-model", provider: "openai", modelId: "gpt-4o" },
 * });
 *
 * const session = await app.createSession();
 * const handle = await session.send({ messages: [{ role: "user", content: "Hello" }] });
 * console.log((await handle.result).response);
 * await app.closeApp();
 * ```
 *
 * Mirrors v1's `createApp(rootElement, options)` ergonomic; the v2
 * variant is async so the substrate's inbox registrations are guaranteed
 * complete before the first session command.
 */

import { AppHarness, type AppHarnessOptions } from "./harness.js";

export type { AppHarnessOptions };

/**
 * Construct an `AppHarness` and wait until it (and its shared
 * sub-harnesses) are ready to serve commands.
 *
 * @param rootElement Agent root — opaque to the app harness; the bound
 *   reconciler impl interprets it (React.ReactNode for the React
 *   reconciler, the framework's root for others).
 * @param options Executor, target, and per-session defaults.
 */
export async function createApp<P = unknown>(
  rootElement: unknown,
  options: Omit<AppHarnessOptions<P>, "rootElement">,
): Promise<AppHarness<P>> {
  const app = new AppHarness<P>({ ...options, rootElement });
  await app.appReady;
  return app;
}
