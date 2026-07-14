/**
 * `spyServerTransport()` — call-recording double over the
 * {@link ServerTransport} contract. Records every `listen(host)` (capturing
 * the host it received) and every `close()`, so gateway tests can assert the
 * gateway fanned out with `this` as the dispatch host.
 *
 *   const spy = spyServerTransport();
 *   const gateway = await createGateway({ transports: [spy] });
 *   await gateway.listen();
 *   expect(spy.listenCount).toBe(1);
 *   expect(spy.hosts[0]).toBe(gateway);   // fanned out with `this`
 *   await gateway.close();
 *   expect(spy.closeCount).toBe(1);
 *
 * It is a working transport — `listen`/`close` resolve — with the only
 * addition being the recording side-effect. Typed against the
 * `ServerTransport` spec interface, so spec drift breaks it at compile time.
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import { ulid } from "@agentick/runtime-next";
import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec-next";

export interface ServerTransportSpy extends ServerTransport {
  /** Hosts passed to `listen`, in call order. */
  readonly hosts: ReadonlyArray<GatewayHarnessProtocol>;
  /** Synonym for `hosts.length`. */
  readonly listenCount: number;
  /** Number of `close()` calls. */
  readonly closeCount: number;
  /** Clear recorded history. */
  reset(): void;
}

export function spyServerTransport(id = `spy-server-transport:${ulid()}`): ServerTransportSpy {
  const hosts: GatewayHarnessProtocol[] = [];
  let closeCount = 0;

  return {
    id,
    async listen(host: GatewayHarnessProtocol): Promise<void> {
      hosts.push(host);
    },
    async close(): Promise<void> {
      closeCount += 1;
    },
    get hosts() {
      return hosts;
    },
    get listenCount() {
      return hosts.length;
    },
    get closeCount() {
      return closeCount;
    },
    reset() {
      hosts.length = 0;
      closeCount = 0;
    },
  };
}
