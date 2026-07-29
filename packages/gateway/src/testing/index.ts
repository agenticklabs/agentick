/**
 * `@agentick/gateway/testing` — test doubles per the Meszaros convention.
 *
 * - `spyServerTransport()` — a call-recording double over the
 *   {@link ServerTransport} contract, used to prove the gateway's `listen` /
 *   `close` fan-out.
 * - `fakeWireCaller()` — a working, simplified {@link WireExtensionContext} that
 *   invokes real wire methods against real harnesses with no transport. For
 *   asserting what a wire method PROJECTS; authorization wants a real gateway.
 */

export * from "./spy-server-transport.js";
export * from "./fake-wire-caller.js";
