/**
 * `@agentick/gateway/testing` — test doubles per the Meszaros
 * convention. `spyServerTransport()` is a call-recording double over the
 * {@link ServerTransport} contract, used to prove the gateway's
 * `listen`/`close` fan-out.
 */

export * from "./spy-server-transport.js";
