/**
 * Smoke tests for the React DevTools bridge.
 *
 * The standalone `react-devtools-core` package is an optional peer
 * dependency — these tests inject a fake `connectToDevTools` so they
 * exercise the bridge without requiring DevTools to be installed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableReactDevTools,
  enableReactDevTools,
  isReactDevToolsConnected,
} from "../react/devtools-bridge.js";

describe("devtools-bridge", () => {
  afterEach(() => {
    disableReactDevTools();
  });

  it("connects when a connectToDevTools implementation is injected", async () => {
    const connectToDevTools = vi.fn();
    const outcome = await enableReactDevTools({
      host: "localhost",
      port: 4321,
      connectToDevTools,
    });

    expect(outcome).toEqual({ status: "connected", host: "localhost", port: 4321 });
    expect(connectToDevTools).toHaveBeenCalledTimes(1);
    const arg = connectToDevTools.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.host).toBe("localhost");
    expect(arg.port).toBe(4321);
    expect(isReactDevToolsConnected()).toBe(true);
  });

  it("is idempotent — second call returns already-connected", async () => {
    const connectToDevTools = vi.fn();
    await enableReactDevTools({ connectToDevTools });
    const second = await enableReactDevTools({ connectToDevTools });
    expect(second).toEqual({ status: "already-connected" });
    expect(connectToDevTools).toHaveBeenCalledTimes(1);
  });

  it("returns failed when the injected connect throws", async () => {
    const err = new Error("boom");
    const connectToDevTools = vi.fn(() => {
      throw err;
    });
    const outcome = await enableReactDevTools({ connectToDevTools });
    expect(outcome).toEqual({ status: "failed", error: err });
    expect(isReactDevToolsConnected()).toBe(false);
  });

  it("disableReactDevTools resets state so enable can retry", async () => {
    const connectToDevTools = vi.fn();
    await enableReactDevTools({ connectToDevTools });
    expect(isReactDevToolsConnected()).toBe(true);

    disableReactDevTools();
    expect(isReactDevToolsConnected()).toBe(false);

    const outcome = await enableReactDevTools({ connectToDevTools });
    expect(outcome.status).toBe("connected");
    expect(connectToDevTools).toHaveBeenCalledTimes(2);
  });
});
