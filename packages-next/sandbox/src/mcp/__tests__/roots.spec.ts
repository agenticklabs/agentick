/**
 * Sandbox → MCP roots projection (ADR 65, outbound direction).
 *
 * Pins the FLAGSHIP source: `sandboxRootsSource` reflects live mounts
 * (add → present, remove → gone), and `bindSandboxRootsToClient` fires
 * `notifyRootsListChanged()` on every mount-topology change so a connected
 * server re-pulls. The no-sandbox standalone guarantee (a static list /
 * provider fn served on `roots/list` with NO sandbox in the graph) is
 * pinned in `@agentick/mcp-next` (`__tests__/wave2-client.spec.ts` — the
 * ADR-65 "roots works standalone" test).
 *
 * @verifiedBy this file — sandboxRootsSource + bindSandboxRootsToClient.
 */

import { describe, expect, it, vi } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import type { McpClientHarness } from "@agentick/mcp-next";
import { waitFor } from "@agentick/utils-next/testing";

import { SandboxHarness } from "../../harness.js";
import { fakeSandboxProvider } from "../../testing/fake.js";
import { sandboxRootsSource, bindSandboxRootsToClient } from "../index.js";

async function mountHarness(): Promise<SandboxHarness> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const elicitation = new ElicitationHarness("test-sb:elicitation", journal, bus, inbox);
  await elicitation.ready;
  const harness = await SandboxHarness.fromProvider(journal, bus, inbox, {
    sandboxId: "test-sb",
    provider: fakeSandboxProvider(),
    options: { mountAllow: ["/host/**"] },
    elicitation,
  });
  await harness.ready;
  return harness;
}

describe("sandboxRootsSource (ADR 65 — outbound flagship source)", () => {
  it("always projects the workspace root", async () => {
    const sandbox = await mountHarness();
    const source = sandboxRootsSource(sandbox);
    const roots = await (source as () => Promise<readonly { uri: string; name?: string }[]>)();
    expect(roots).toEqual([{ uri: "file:///sandbox", name: "workspace" }]);
  });

  it("reflects live mounts: present after add-mount, gone after remove-mount", async () => {
    const sandbox = await mountHarness();
    const source = sandboxRootsSource(sandbox) as () => Promise<
      readonly { uri: string; name?: string }[]
    >;

    await sandbox.addMount({ mount: { hostPath: "/host/data", sandboxPath: "/data" } });
    const afterAdd = await source();
    expect(afterAdd).toContainEqual({ uri: "file:///data", name: "data" });
    expect(afterAdd).toContainEqual({ uri: "file:///sandbox", name: "workspace" });

    await sandbox.removeMount({ sandboxPath: "/data" });
    const afterRemove = await source();
    expect(afterRemove).not.toContainEqual({ uri: "file:///data", name: "data" });
    expect(afterRemove).toEqual([{ uri: "file:///sandbox", name: "workspace" }]);
  });
});

describe("bindSandboxRootsToClient (ADR 65 — live sync)", () => {
  it("fires notifyRootsListChanged on every mount-topology change", async () => {
    const sandbox = await mountHarness();
    const notify = vi.fn().mockResolvedValue(undefined);
    const client = { notifyRootsListChanged: notify } as unknown as McpClientHarness;

    const unsubscribe = bindSandboxRootsToClient(sandbox, client);

    await sandbox.addMount({ mount: { hostPath: "/host/a", sandboxPath: "/a" } });
    await sandbox.addMount({ mount: { hostPath: "/host/b", sandboxPath: "/b" } });
    await sandbox.removeMount({ sandboxPath: "/a" });
    // notify is fire-and-forget (void Promise) — settle the microtasks.
    await waitFor(() => notify.mock.calls.length >= 3, { description: "3 notifications" });
    expect(notify).toHaveBeenCalledTimes(3);

    // After unsubscribe, further changes do NOT notify.
    unsubscribe();
    await sandbox.addMount({ mount: { hostPath: "/host/c", sandboxPath: "/c" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("swallows a not-ready client (fire-and-forget, never throws into the mount path)", async () => {
    const sandbox = await mountHarness();
    const notify = vi.fn().mockRejectedValue(new Error("client not ready"));
    const client = { notifyRootsListChanged: notify } as unknown as McpClientHarness;

    bindSandboxRootsToClient(sandbox, client);
    // The rejected notify must not surface as a mount-command failure.
    await expect(
      sandbox.addMount({ mount: { hostPath: "/host/x", sandboxPath: "/x" } }),
    ).resolves.toBeUndefined();
  });
});
