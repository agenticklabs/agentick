/**
 * The language-neutral contract suite, driven against a REAL V8 isolate — real
 * isolates, real bindings marshaled across the boundary, real disposal on abort.
 * The isolate must pass the SAME suite the subprocess runtime passes; that is
 * how we know the engine swap is truthful and not a different contract wearing
 * the same name.
 *
 * TypeScript mode is certified with the SAME vocabulary — JavaScript is valid
 * TypeScript, so every program the suite writes must still pass once types are
 * stripped on the way into the isolate.
 */

import { runCodeConformance } from "@agentick/code/testing";

import { isolateCodeProbe } from "../testing/isolate-code-probe.js";

runCodeConformance(isolateCodeProbe());
runCodeConformance(isolateCodeProbe({ language: "typescript" }));
