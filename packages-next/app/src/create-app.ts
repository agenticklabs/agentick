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
 *
 * **Cluster integration.** Pass a `cluster: ClusterFactory` (from any
 * of the `defineXCluster` factories) to wrap the app's local substrate
 * with cluster-aware bus + inbox routing. createApp owns the
 * lifecycle: `app.closeApp()` tears down the cluster.
 *
 * One cluster per process. Multiple `createApp` calls with the same
 * `ClusterFactory` produce INDEPENDENT clusters (double connections,
 * double-delivery). For multi-app deployments, use a gateway — the
 * gateway owns the cluster and apps inherit. See ADR 35 §10.
 */

import type { ClusterFactory, ClusterParent } from "@agentick/cluster-next";
import { ulid } from "@agentick/utils-next";

import { AppHarness, type AppHarnessOptions } from "./harness.js";

export type { AppHarnessOptions };

/**
 * Options for {@link createApp}. Extends {@link AppHarnessOptions}
 * with a `cluster` slot that wraps the local substrate before the
 * app constructs its sub-harnesses.
 */
export interface CreateAppOptions<P = unknown> extends Omit<AppHarnessOptions<P>, "rootElement"> {
  /**
   * Optional cluster factory — produced by `defineUnixCluster`,
   * `defineTcpCluster`, `defineWsCluster`, `defineRedisCluster`,
   * or any custom `ClusterFactory`. When set, the app's substrate
   * (`bus`, `inbox`, `journal`) is replaced with the cluster's
   * wrapped substrate. `app.closeApp()` closes the cluster.
   *
   * For multi-app processes, prefer wiring the cluster at the
   * gateway level — independent clusters per app double-deliver.
   * See ADR 35 §10.
   */
  readonly cluster?: ClusterFactory;
}

/**
 * Construct an `AppHarness` and wait until it (and its shared
 * sub-harnesses) are ready to serve commands.
 *
 * @param rootElement Agent root — opaque to the app harness; the bound
 *   reconciler impl interprets it (React.ReactNode for the React
 *   reconciler, the framework's root for others).
 * @param options Executor, target, per-session defaults, and optional
 *   cluster wiring.
 */
export async function createApp<P = unknown>(
  rootElement: unknown,
  options: CreateAppOptions<P>,
): Promise<AppHarness<P>> {
  const { cluster, ...rest } = options;

  // Substrate slot resolution: if the adopter supplied instances,
  // use them as the local substrate; otherwise the AppHarness
  // constructor's defaults stand in. Cluster wrapping only
  // happens here when cluster is set.
  let appOptions = rest;
  let clusterClose: (() => Promise<void>) | undefined;

  if (cluster) {
    // The cluster needs concrete substrate instances to wrap. If the
    // adopter passed factories (functions), we can't resolve them
    // here without constructing them ourselves — that path is
    // intentionally unsupported. Adopters who need cluster + custom
    // substrate factories should resolve the factories themselves
    // and pass instances.
    if (
      typeof rest.bus === "function" ||
      typeof rest.inbox === "function" ||
      typeof rest.journal === "function"
    ) {
      throw new Error(
        "createApp({ cluster }) requires substrate instances (not factories) " +
          "for bus / inbox / journal. Resolve the factories yourself before " +
          "passing to createApp, or omit them entirely to use defaults.",
      );
    }
    const localBus = rest.bus;
    const localInbox = rest.inbox;
    const localJournal = rest.journal;

    // Build a ClusterParent shell from the local substrate. Defaults
    // mirror what AppHarness uses internally so the cluster wraps a
    // consistent base regardless of whether the adopter supplied
    // explicit instances.
    const closeHandlers: Array<() => Promise<void> | void> = [];
    const { LocalEventBus, LocalInbox, MemoryJournal } = await import("@agentick/runtime-next");
    const parent: ClusterParent = {
      id: rest.appId ?? `app:${ulid()}:cluster-parent`,
      bus: localBus ?? new LocalEventBus(),
      inbox: localInbox ?? new LocalInbox(),
      journal: localJournal ?? new MemoryJournal({ capacity: 10_000 }),
      onClose: (h) => {
        closeHandlers.push(h);
      },
    };

    // Run the cluster factory. Factories can return sync or Promise;
    // collapse via Promise.resolve.
    const resolved = await Promise.resolve(cluster(parent));

    // Use the wrapped substrate as the app's substrate.
    appOptions = {
      ...rest,
      bus: resolved.bus,
      inbox: resolved.inbox,
      journal: resolved.journal,
    };

    // Lifecycle: when app.closeApp() fires, run the cluster's
    // parent.onClose handlers in registration order.
    clusterClose = async () => {
      for (const h of closeHandlers) {
        try {
          await h();
        } catch {
          // best effort — cluster teardown errors don't block app close
        }
      }
    };
  }

  const app = new AppHarness<P>({ ...appOptions, rootElement });

  if (clusterClose) {
    app.addInternalCloseHandler(clusterClose);
  }

  await app.appReady;
  return app;
}
