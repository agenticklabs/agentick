/**
 * The Lambda provider runs the shared #218 conformance suite against a REAL
 * in-VM agent over a loopback wire — real HTTP/WS, real fs, real bash (ADR 60).
 * Not a fake shell: the only piece replaced is the AWS control plane, which is
 * swapped for {@link fakeLambdaMicrovmsControlPlane} (a working loopback impl
 * that spins up a real {@link startSandboxAgent} per microVM).
 *
 * This exercises exec-stream / readFile / writeFile / editFile / destroy
 * exactly as the ADR-59 contract demands — everything except the AWS control
 * plane (that lives in `control-plane.spec.ts`, gated on real AWS). It MUST
 * pass green with no AWS access.
 */

import { afterAll } from "vitest";
import { runSandboxProviderConformance } from "@agentick/sandbox/testing";
import { lambdaProvider } from "../provider.js";
import { fakeLambdaMicrovmsControlPlane } from "../testing/index.js";

// One shared loopback control plane; every microVM it starts is torn down on
// teardown (a safety net beyond the suite's per-handle `destroy()`).
const controlPlane = fakeLambdaMicrovmsControlPlane();
afterAll(async () => {
  await controlPlane.stopAll();
});

runSandboxProviderConformance(() => lambdaProvider({ imageIdentifier: "loopback", controlPlane }), {
  label: "lambda (loopback)",
});
