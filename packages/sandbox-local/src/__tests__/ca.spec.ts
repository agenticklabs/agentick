import { describe, it, expect, afterEach } from "vitest";
import { EphemeralCA } from "../network/ca";
import { access } from "node:fs/promises";

describe("EphemeralCA", () => {
  let ca: EphemeralCA;

  afterEach(async () => {
    await ca?.cleanup();
  });

  it("generates a CA certificate", async () => {
    ca = new EphemeralCA();
    await ca.init();

    expect(ca.caCertPath).toBeTruthy();
    await access(ca.caCertPath!); // File should exist
  });

  it("generates host certificates", async () => {
    ca = new EphemeralCA();
    await ca.init();

    const certs = await ca.certForHost("example.com");
    expect(certs.certPath).toBeTruthy();
    expect(certs.keyPath).toBeTruthy();

    await access(certs.certPath);
    await access(certs.keyPath);
  });

  it("caches host certificates", async () => {
    ca = new EphemeralCA();
    await ca.init();

    const first = await ca.certForHost("cached.example.com");
    const second = await ca.certForHost("cached.example.com");
    expect(first).toBe(second); // Same reference
  });

  it("generates different certs for different hosts", async () => {
    ca = new EphemeralCA();
    await ca.init();

    const a = await ca.certForHost("a.example.com");
    const b = await ca.certForHost("b.example.com");
    expect(a.certPath).not.toBe(b.certPath);
  });

  it("throws if not initialized", async () => {
    ca = new EphemeralCA();
    await expect(ca.certForHost("test.com")).rejects.toThrow("not initialized");
  });

  it("cleans up cert files", async () => {
    ca = new EphemeralCA();
    await ca.init();

    const certs = await ca.certForHost("cleanup.example.com");
    const certPath = certs.certPath;
    const caPath = ca.caCertPath!;

    await ca.cleanup();

    await expect(access(certPath)).rejects.toThrow("ENOENT");
    await expect(access(caPath)).rejects.toThrow("ENOENT");
  });
});
