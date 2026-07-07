/**
 * Invokes the MCP conformance suite against the in-package harnesses.
 *
 * This is the one place the suite is wired for CI. It is also the seam
 * that keeps `@agentick/resources-next` a DEV dependency: the suite
 * itself imports no concrete sibling harness (see
 * `McpConformanceFactories`); this spec — a test — provides the concrete
 * `ResourcesHarness` / `PromptsHarness` / `ElicitationHarness`.
 *
 * Runs Parts A (loopback, both eras), B1 (reference client, always), B2
 * (reference server, gated → skipped unless
 * `@modelcontextprotocol/server-everything` is present /
 * `MCP_REFERENCE_SERVER` is set), and C (era matrix + codec
 * normalization).
 *
 * @see ../conformance.ts for the section-by-section contract.
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import { ResourcesHarness } from "@agentick/resources-next";
import { PromptsHarness } from "@agentick/prompts-next";
import { ElicitationHarness } from "@agentick/elicitation-next";

import { runMcpConformance } from "../index.js";

runMcpConformance({
  async makeResources() {
    const h = new ResourcesHarness(
      `resources:${ulid()}`,
      new MemoryJournal({ capacity: 256 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await h.ready;
    return h;
  },
  async makePrompts() {
    const h = new PromptsHarness(
      `prompts:${ulid()}`,
      new MemoryJournal({ capacity: 256 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await h.ready;
    return h;
  },
  async makeElicitation(scopeId, journal, bus, inbox) {
    const h = new ElicitationHarness(scopeId, journal, bus, inbox);
    await h.ready;
    return h;
  },
});
