import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { DevToolsServer } from "../server/devtools-server";

describe("DevToolsServer", () => {
  it("does not crash when port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve());
    });

    const address = blocker.address();
    if (!address || typeof address === "string") {
      blocker.close();
      throw new Error("Failed to acquire a TCP port for the test");
    }

    const devtools = new DevToolsServer({ port: address.port, host: "127.0.0.1" });

    expect(() => devtools.start()).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((devtools as unknown as { server: unknown }).server).toBeNull();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
