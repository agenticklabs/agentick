/**
 * The language-neutral suite, driven against a REAL subprocess runtime — real
 * spawns, real JavaScript, real kills. This is the bet `@agentick/code` was
 * built on: one suite that certified a recorded-instruction fake now certifies
 * a provider whose language is JavaScript, with no branch in the suite.
 */

import { runCodeConformance } from "@agentick/code/testing";

import { hostCodeProbe } from "../testing/host-code-probe.js";

runCodeConformance(hostCodeProbe());
