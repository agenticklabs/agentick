/**
 * `defaultNodeId` / `resolveNodeId` — auto-default for cluster
 * adopters. Tests the happy path and the suspicious-hostname guard
 * (the footgun we surface, not hide).
 */

import { hostname } from "node:os";

import { describe, expect, it } from "vitest";

import { defaultNodeId, resolveNodeId } from "../default-node-id.js";

describe("defaultNodeId — happy path", () => {
  it("returns ${hostname}:${pid} for a normal hostname", () => {
    const result = defaultNodeId({
      hostname: () => "my-host-42",
      pid: () => 1234,
    });
    expect(result.nodeId).toBe("my-host-42:1234");
    expect(result.suspicious).toBe(false);
    expect(result.reason).toContain('hostname="my-host-42"');
    expect(result.reason).toContain("pid=1234");
  });

  it("uses real os.hostname() and process.pid when no overrides are supplied", () => {
    const real = hostname();
    const result = defaultNodeId();
    expect(result.nodeId).toBe(`${real || "unknown"}:${process.pid}`);
  });
});

describe("defaultNodeId — suspicious hostnames", () => {
  it("flags an empty hostname as suspicious with a clear reason", () => {
    const result = defaultNodeId({ hostname: () => "", pid: () => 5 });
    expect(result.suspicious).toBe(true);
    expect(result.nodeId).toBe("unknown:5");
    expect(result.reason).toMatch(/replicas with this hostname will collide/);
    expect(result.reason).toMatch(/NODE_ID/);
  });

  it("flags 'localhost' as suspicious — typical of containers without HOSTNAME set", () => {
    const result = defaultNodeId({ hostname: () => "localhost", pid: () => 7 });
    expect(result.suspicious).toBe(true);
    expect(result.nodeId).toBe("localhost:7");
  });

  it("survives a hostname() that throws — falls back to 'unknown'", () => {
    const result = defaultNodeId({
      hostname: () => {
        throw new Error("EACCES");
      },
      pid: () => 9,
    });
    expect(result.suspicious).toBe(true);
    expect(result.nodeId).toBe("unknown:9");
  });
});

describe("resolveNodeId", () => {
  it("returns the explicit value as-is and does NOT emit a diagnostic", () => {
    const diags: Array<{ name: string; payload?: unknown }> = [];
    const result = resolveNodeId("my-explicit-node", (name, payload) => {
      diags.push({ name, payload });
    });
    expect(result).toBe("my-explicit-node");
    expect(diags).toEqual([]);
  });

  it("accepts a synchronous thunk and invokes it eagerly", () => {
    const diags: Array<{ name: string; payload?: unknown }> = [];
    let callCount = 0;
    const thunk = (): string => {
      callCount += 1;
      return "lazy-resolved-id";
    };
    const result = resolveNodeId(thunk, (n, p) => diags.push({ name: n, payload: p }));
    expect(result).toBe("lazy-resolved-id");
    expect(callCount).toBe(1);
    expect(diags).toEqual([]); // explicit (via thunk) — no diagnostic
  });

  it("falls back to the auto-default when explicit is undefined", () => {
    const result = resolveNodeId(undefined);
    expect(result).toMatch(/.+:\d+$/);
  });

  it("emits cluster:nodeId:auto-defaulted on the happy path", () => {
    const real = hostname();
    if (real === "" || real === "localhost") return; // suspicious path covered separately
    const diags: Array<{ name: string; payload?: unknown }> = [];
    resolveNodeId(undefined, (name, payload) => {
      diags.push({ name, payload });
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.name).toBe("cluster:nodeId:auto-defaulted");
    expect((diags[0]!.payload as { nodeId: string }).nodeId).toBe(`${real}:${process.pid}`);
  });

  it("does not throw when onDiagnostic is omitted", () => {
    expect(() => resolveNodeId(undefined)).not.toThrow();
  });
});
