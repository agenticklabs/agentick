/**
 * ClientHandlerRegistry — per-event merge-rule dispatch.
 *
 * README claims that the registry runs handlers per the event's
 * declared `MergeKind` (observer / first-non-null-wins /
 * any-reconnect-wins). Verifies each merge kind directly.
 */

import { describe, expect, it } from "vitest";
import type { ClientExtension } from "@agentick/spec";

import { ClientHandlerRegistry } from "../handler-registry.js";

describe("ClientHandlerRegistry — merge kinds", () => {
  it("observer: runs every registered handler in order; returns null", async () => {
    const registry = new ClientHandlerRegistry();
    const seen: string[] = [];
    const a: ClientExtension = {
      name: "a",
      handlers: {
        "connection:opened": () => {
          seen.push("a");
        },
      },
    };
    const b: ClientExtension = {
      name: "b",
      handlers: {
        "connection:opened": () => {
          seen.push("b");
        },
      },
    };
    registry.registerFrom(a);
    registry.registerFrom(b);

    const result = await registry.run("connection:opened", { transport: {} as never }, "observer");
    expect(seen).toEqual(["a", "b"]);
    expect(result).toBeNull();
  });

  it("first-non-null-wins: stops at the first handler returning non-null", async () => {
    const registry = new ClientHandlerRegistry();
    let secondCalled = false;
    const a: ClientExtension = {
      name: "a",
      handlers: {
        "auth:expired": () => null,
      },
    };
    const b: ClientExtension = {
      name: "b",
      handlers: {
        "auth:expired": () => "refresh" as const,
      },
    };
    const c: ClientExtension = {
      name: "c",
      handlers: {
        "auth:expired": () => {
          secondCalled = true;
          return "re-authenticate" as const;
        },
      },
    };
    registry.registerFrom(a);
    registry.registerFrom(b);
    registry.registerFrom(c);

    const result = await registry.run("auth:expired", { reason: "test" }, "first-non-null-wins");
    expect(result).toBe("refresh");
    expect(secondCalled).toBe(false);
  });

  it("any-reconnect-wins: 'reconnect' vote overrides 'give-up'", async () => {
    const registry = new ClientHandlerRegistry();
    const a: ClientExtension = {
      name: "a",
      handlers: {
        "connection:lost": () => "give-up" as const,
      },
    };
    const b: ClientExtension = {
      name: "b",
      handlers: {
        "connection:lost": () => "reconnect" as const,
      },
    };
    const c: ClientExtension = {
      name: "c",
      handlers: {
        "connection:lost": () => "give-up" as const,
      },
    };
    registry.registerFrom(a);
    registry.registerFrom(b);
    registry.registerFrom(c);

    const result = await registry.run(
      "connection:lost",
      { reason: { kind: "closed", message: "x" } },
      "any-reconnect-wins",
    );
    expect(result).toBe("reconnect");
  });

  it("any-reconnect-wins: defaults to last non-null vote when no reconnect", async () => {
    const registry = new ClientHandlerRegistry();
    const a: ClientExtension = {
      name: "a",
      handlers: {
        "connection:lost": () => "give-up" as const,
      },
    };
    registry.registerFrom(a);

    const result = await registry.run(
      "connection:lost",
      { reason: { kind: "closed", message: "x" } },
      "any-reconnect-wins",
    );
    expect(result).toBe("give-up");
  });

  it("returns null for events with no registered handlers", async () => {
    const registry = new ClientHandlerRegistry();
    const result = await registry.run("auth:expired", { reason: "test" }, "first-non-null-wins");
    expect(result).toBeNull();
  });

  it("throws on an unknown merge kind (exhaustiveness guard)", async () => {
    const registry = new ClientHandlerRegistry();
    const a: ClientExtension = {
      name: "a",
      handlers: {
        "connection:opened": () => undefined,
      },
    };
    registry.registerFrom(a);

    await expect(
      registry.run("connection:opened", { transport: {} as never }, "not-a-real-kind" as never),
    ).rejects.toThrow(/unknown merge kind/);
  });
});
