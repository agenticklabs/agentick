/**
 * The language-neutral suite, driven against a REAL subprocess runtime — real
 * spawns, real JavaScript, real kills. This is the bet `@agentick/code` was
 * built on: one suite that certified a recorded-instruction fake now certifies
 * a provider whose language is JavaScript, with no branch in the suite.
 *
 * The TypeScript mode is certified with the SAME vocabulary, and that is the
 * additivity proof: JavaScript is valid TypeScript, so every JavaScript program
 * the suite writes must still pass once types are being stripped on the way in.
 * The pins that need TypeScript to SAY anything live in `typescript.spec.ts`.
 */

import { runCodeConformance } from "@agentick/code/testing";

import { hostCodeProbe } from "../testing/host-code-probe.js";

runCodeConformance(hostCodeProbe());
runCodeConformance(hostCodeProbe({ language: "typescript" }));
