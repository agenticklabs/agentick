/**
 * `RequestStateCodec` (default AES-256-GCM) — the sealed `requestState` handle.
 * Proves the MRTR §Security posture in isolation: round-trip, tamper rejection,
 * expiry rejection, unknown-kid rejection, and kid rotation (a token minted
 * under a now-previous key still verifies).
 */

import { describe, expect, it } from "vitest";

import {
  createRequestStateCodec,
  type RequestStateClaims,
} from "../substrate/request-state-codec.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";

function claims(overrides: Partial<RequestStateClaims> = {}): RequestStateClaims {
  const now = Date.now();
  return {
    correlationId: "req:1",
    principal: "acme/u-1",
    round: 0,
    iat: now,
    exp: now + 60_000,
    ...overrides,
  };
}

describe("RequestStateCodec (AES-256-GCM)", () => {
  it("mint → verify round-trips the claims", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await codec.mint(claims());
    const opened = await codec.verify(token);
    expect(opened).toEqual(claims({ iat: opened!.iat, exp: opened!.exp }));
    expect(opened?.correlationId).toBe("req:1");
    expect(opened?.principal).toBe("acme/u-1");
  });

  it("the token is opaque — a viewer cannot read the principal from it", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await codec.mint(claims());
    expect(token).not.toContain("acme");
    expect(token).not.toContain("req:1");
  });

  it("a tampered token fails verification (null, not throw)", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await codec.mint(claims());
    const parts = token.split(".");
    const ct = parts[2]!;
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === "AA" ? "AB" : "AA");
    expect(await codec.verify(`${parts[0]}.${parts[1]}.${flipped}`)).toBeNull();
  });

  it("garbage / wrong-shape input verifies to null", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    expect(await codec.verify("not-a-token")).toBeNull();
    expect(await codec.verify("a.b.c")).toBeNull();
    expect(await codec.verify("")).toBeNull();
  });

  it("an expired token verifies to null", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await codec.mint(claims({ exp: Date.now() - 1 }));
    expect(await codec.verify(token)).toBeNull();
  });

  it("a token sealed under an unknown kid verifies to null", async () => {
    const a = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await a.mint(claims());
    const b = createRequestStateCodec({ keys: [{ kid: "k2", secret: KEY_B }] });
    expect(await b.verify(token)).toBeNull();
  });

  it("rotation: a token minted under the previous key still verifies after rotating", async () => {
    const before = createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }] });
    const token = await before.mint(claims());
    // k2 is now current; k1 kept in the ring for its TTL window.
    const after = createRequestStateCodec({
      keys: [
        { kid: "k2", secret: KEY_B },
        { kid: "k1", secret: KEY_A },
      ],
      currentKid: "k2",
    });
    const opened = await after.verify(token);
    expect(opened?.correlationId).toBe("req:1");
    // New tokens mint under k2.
    const fresh = await after.mint(claims({ correlationId: "req:2" }));
    expect((await after.verify(fresh))?.correlationId).toBe("req:2");
  });

  it("a string secret is accepted (hashed to a 256-bit key)", async () => {
    const codec = createRequestStateCodec({ keys: [{ kid: "k1", secret: "a short passphrase" }] });
    const token = await codec.mint(claims());
    expect((await codec.verify(token))?.correlationId).toBe("req:1");
  });

  it("construction rejects an empty keyring and an unknown currentKid", () => {
    expect(() => createRequestStateCodec({ keys: [] })).toThrow("at least one key");
    expect(() =>
      createRequestStateCodec({ keys: [{ kid: "k1", secret: KEY_A }], currentKid: "nope" }),
    ).toThrow("not in keys");
  });
});
