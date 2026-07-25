/**
 * `withCredentials({ store })` — app-level `AppExtension` factory for
 * the credentials surface.
 *
 * Constructs a single {@link CredentialsHarness} wired to the
 * AppHarness's shared substrate at install time and registers it on
 * the app's extension-bridges map. Every session this app creates
 * inherits the SAME harness instance via the bridge-cascade pattern
 * — sessions see `bridges.credentials` pointing at the app-shared
 * harness, so OAuth tokens / API keys are visible across sessions
 * of the same principal without re-auth.
 *
 * **App-level only** in 281b.2. When #254 ships formal
 * `GatewayExtension`, the same factory gains a gateway-level
 * variant that cascades to apps — adopter API unchanged.
 *
 * For test-only per-session credentials (uncommon), construct a
 * `CredentialsHarness` directly via `fakeCredentialsHarness()` and
 * register it via a custom `SessionExtension`. The app-level
 * pattern here is the production path.
 *
 * Lifecycle:
 *   1. Adopter passes `{ store }` to `withCredentials(...)`.
 *   2. App-construction time: `install(installer)` runs once per app.
 *      Constructs ONE `CredentialsHarness` over the supplied store +
 *      the app's substrate (journal/bus/inbox).
 *   3. `installer.registerNamespace("credentials", harness)` puts the
 *      harness on the app's `extensionBridges` map.
 *   4. Each subsequent `createSession()` call copies that map into the
 *      session's bridge tree — sessions see the SAME instance.
 *   5. `installer.onClose(() => harness.close())` schedules cleanup at
 *      app shutdown.
 */

import type { AppExtension, AppInstaller } from "@agentick/spec";

import { CredentialsHarness } from "./harness.js";
import type { CredentialsStore } from "./store.js";

export interface WithCredentialsOptions {
  /**
   * The pluggable backend adapter. Adopter supplies ONE — typically
   * `inMemoryCredentialsStore()` for tests, an OS-keychain or
   * encrypted-file adapter in production. Same adapter shape any
   * adopter-written backend (1Password, Vault, AWS Secrets Manager,
   * etc.) implements.
   */
  readonly store: CredentialsStore;
}

const EXTENSION_NAME = "@agentick/credentials";

export function withCredentials(options: WithCredentialsOptions): AppExtension {
  return {
    name: EXTENSION_NAME,
    target: "app",
    install(installer: AppInstaller): void {
      const { substrate } = installer;
      // The harness's scope id matches the app id — every harness
      // event scopes under the owning app for telemetry / clustering.
      const harness = new CredentialsHarness(
        `${installer.hostId}:credentials`,
        options.store,
        substrate.journal,
        substrate.bus,
        substrate.inbox,
      );
      installer.registerNamespace("credentials", harness);
      installer.onClose(() => harness.close());
    },
  };
}
