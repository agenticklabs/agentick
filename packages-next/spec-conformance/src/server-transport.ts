/**
 * ServerTransport conformance (ADR 84 §2) — behavior every
 * `ServerTransport` implementation must satisfy regardless of wire format.
 *
 * The symmetric server-side counterpart to {@link runTransportConformance}.
 * Where the client suite exercises `connect`/`request`/`subscribe`, this
 * suite exercises the two-method server contract:
 *
 *   - `listen(host)` binds + begins accepting, receiving the gateway as the
 *     dispatch host;
 *   - `close()` tears down;
 *   - both are idempotent.
 *
 * Wire-specific behavior (real port binding, TLS, peer creds, HTTP topology)
 * lives in the per-transport package's own `__tests__`; this suite pins the
 * abstraction contract the gateway relies on when it fans out.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import { describe, expect, it } from "vitest";
import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec-next";

/**
 * Produce a fresh {@link ServerTransport} to exercise. Any wire config
 * (port/path/tls) is closed over here — the suite only supplies the host.
 */
export type ServerTransportConformanceFactory = () => ServerTransport;

/**
 * A minimal stand-in for the dispatch host. The abstract contract only
 * requires that `listen` accept + retain whatever host it is handed; the
 * suite never invokes host methods, so a cast-through placeholder suffices
 * (real host wiring is a per-transport concern, verified where the transport
 * actually routes frames).
 */
function fakeHost(): GatewayHarnessProtocol {
  return { id: "conformance-host" } as unknown as GatewayHarnessProtocol;
}

export function runServerTransportConformance(
  name: string,
  factory: ServerTransportConformanceFactory,
): void {
  describe(`ServerTransport conformance — ${name}`, () => {
    it("exposes a stable string id", () => {
      const transport = factory();
      expect(typeof transport.id).toBe("string");
      expect(transport.id.length).toBeGreaterThan(0);
    });

    it("binds on listen(host)", async () => {
      const transport = factory();
      await expect(transport.listen(fakeHost())).resolves.toBeUndefined();
      await transport.close();
    });

    it("tears down on close()", async () => {
      const transport = factory();
      await transport.listen(fakeHost());
      await expect(transport.close()).resolves.toBeUndefined();
    });

    it("is idempotent on listen() — a second listen is a safe no-op", async () => {
      const transport = factory();
      await transport.listen(fakeHost());
      await expect(transport.listen(fakeHost())).resolves.toBeUndefined();
      await transport.close();
    });

    it("is idempotent on close() — closing twice (or unbound) resolves", async () => {
      const transport = factory();
      // Close without ever binding.
      await expect(transport.close()).resolves.toBeUndefined();
      // Bind, then double-close.
      await transport.listen(fakeHost());
      await transport.close();
      await expect(transport.close()).resolves.toBeUndefined();
    });

    it("can re-listen after close() (bind → close → bind)", async () => {
      const transport = factory();
      await transport.listen(fakeHost());
      await transport.close();
      await expect(transport.listen(fakeHost())).resolves.toBeUndefined();
      await transport.close();
    });
  });
}
