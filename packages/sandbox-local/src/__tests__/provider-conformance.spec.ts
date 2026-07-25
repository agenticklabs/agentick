/**
 * The local reference provider runs the shared provider conformance suite
 * (#218) against a REAL instance — real temp workspaces, a real shell,
 * real atomic writes, real runtime mounts. Not a fake (ADR 59).
 */

import { runSandboxProviderConformance } from "@agentick/sandbox/testing";
import { localProvider } from "../provider.js";

runSandboxProviderConformance(() => localProvider(), { label: "local" });
