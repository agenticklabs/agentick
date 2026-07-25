/**
 * `@agentick/sandbox-lambda/testing` — test doubles for the Lambda
 * MicroVMs provider (ADR 60).
 *
 * The double lives WITH the provider it exercises. `fakeLambdaMicrovmsControlPlane`
 * is a working loopback control plane (Meszaros fake) that starts a REAL in-VM
 * agent per microVM — so the provider's full create/exec/fs/destroy path runs
 * over a real HTTP/WS wire against a real fs + bash, with only the AWS control
 * plane replaced. The provider conformance suite itself ships from
 * `@agentick/sandbox/testing`.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

export {
  fakeLambdaMicrovmsControlPlane,
  type FakeControlPlane,
  type FakeControlPlaneOptions,
} from "./loopback-control-plane.js";
