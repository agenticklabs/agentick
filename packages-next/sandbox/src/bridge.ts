/**
 * `SandboxBridge` — factory + registry for `SandboxHarness` instances.
 *
 * The bridge is created at extension install time (`withSandbox()`),
 * which is when the AppHarness's substrate (journal / bus / inbox) is
 * accessible. The bridge closes over the substrate and exposes
 * `createHarness(init)` so React components — which never see the
 * substrate — can construct harnesses that publish into the app's bus.
 *
 * Without this pattern, sandbox events would land in an isolated bus
 * the rest of the app can't read; `app.events({ surface: "sandbox" })`
 * would return nothing. Routing creation through the bridge keeps the
 * audit trail unified — the load-bearing reason sandbox is a harness
 * in the first place.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  AppSubstrate,
  ElicitationHarnessProtocol,
  SandboxACL,
  SandboxCreateOptions,
  SandboxProvider,
  Unsubscribe,
} from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";

import { SandboxHarness } from "./harness.js";

export interface SandboxRegistration {
  readonly id: string;
  readonly workspacePath: string;
  readonly status: "creating" | "ready" | "degraded" | "failed" | "destroyed";
}

export interface CreateSandboxHarnessInput {
  readonly sandboxId: string;
  readonly provider: SandboxProvider;
  readonly options: SandboxCreateOptions;
  readonly acl?: SandboxACL;
  readonly permissionTimeoutDecision?: "allow-once" | "deny";
  readonly permissionTimeoutMs?: number;
  /**
   * Elicitation harness used by the new sandbox harness's permission
   * gate. Required: every permission round-trip routes through this
   * (one wire shape, one channel). The session-scoped elicitation
   * harness is the canonical source — pull it from
   * `useBridges().elicitation` in React, or thread it through
   * explicitly from the constructing context.
   */
  readonly elicitation: ElicitationHarnessProtocol;
}

export interface SandboxBridge {
  /**
   * Construct a `SandboxHarness` wired into the app's shared
   * substrate. The harness's events flow into `app.events()` and its
   * operations journal into the same store as everything else.
   *
   * Auto-registers the harness with the bridge — callers do not need
   * to also call `register`. The unregister handle is returned via
   * the registration listener path.
   */
  createHarness(input: CreateSandboxHarnessInput): Promise<SandboxHarness>;

  /**
   * Manually register a harness — useful when adopters build a
   * harness outside the bridge's factory and want it visible to
   * consumers via `get()` / `list()`.
   */
  register(harness: SandboxHarness): Unsubscribe;
  unregister(id: string): void;
  get(id: string): SandboxHarness | undefined;
  list(): readonly SandboxRegistration[];
  /** Notify when an entry is registered / unregistered. */
  subscribe(listener: () => void): Unsubscribe;
}

export interface CreateSandboxBridgeOptions {
  readonly substrate: AppSubstrate;
}

export function createSandboxBridge(options: CreateSandboxBridgeOptions): SandboxBridge {
  const harnesses = new Map<string, SandboxHarness>();
  const listeners = createNotifier();
  const notify = (): void => listeners.notify();

  const bridge: SandboxBridge = {
    async createHarness(input): Promise<SandboxHarness> {
      const harness = await SandboxHarness.fromProvider(
        options.substrate.journal,
        options.substrate.bus,
        options.substrate.inbox,
        {
          sandboxId: input.sandboxId,
          provider: input.provider,
          options: input.options,
          elicitation: input.elicitation,
          ...(input.acl !== undefined ? { acl: input.acl } : {}),
          ...(input.permissionTimeoutDecision !== undefined
            ? { permissionTimeoutDecision: input.permissionTimeoutDecision }
            : {}),
          ...(input.permissionTimeoutMs !== undefined
            ? { permissionTimeoutMs: input.permissionTimeoutMs }
            : {}),
        },
      );
      await harness.ready;
      harnesses.set(input.sandboxId, harness);
      notify();
      return harness;
    },
    register(harness): Unsubscribe {
      harnesses.set(harness.sandboxId, harness);
      notify();
      return () => {
        if (harnesses.get(harness.sandboxId) === harness) {
          harnesses.delete(harness.sandboxId);
          notify();
        }
      };
    },
    unregister(id) {
      if (harnesses.delete(id)) notify();
    },
    get(id) {
      return harnesses.get(id);
    },
    list(): readonly SandboxRegistration[] {
      const out: SandboxRegistration[] = [];
      for (const [id, h] of harnesses) {
        out.push({ id, workspacePath: h.workspacePath, status: h.status });
      }
      return out;
    },
    subscribe(listener): Unsubscribe {
      return listeners.subscribe(listener);
    },
  };
  return bridge;
}

/**
 * Convenience for tests + small-scope adopters: an in-memory bridge
 * not wired to a real `AppSubstrate`. The harnesses it manufactures
 * use local substrate, so events don't flow into a real
 * `app.events()` — fine for unit tests, not for production. Adopters
 * who want unified observability use `createSandboxBridge({ substrate })`
 * from inside an `AppExtension.install()` hook.
 */
export function inMemorySandboxBridge(): SandboxBridge {
  return createSandboxBridge({
    substrate: {
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    },
  });
}
