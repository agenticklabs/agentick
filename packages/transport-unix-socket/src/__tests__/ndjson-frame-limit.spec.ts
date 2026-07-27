/**
 * The NDJSON decoder is bounded.
 *
 * Framing is "read until `\n`", so a peer that never sends one used to make the
 * receiver buffer without limit: memory grew for as long as the peer kept
 * writing, with no frame ever completing and nothing to notice. Host-local trust
 * makes that a low-severity hole, not a non-existent one — a bounded buffer is
 * the defense-in-depth this transport should have had, and the bound is where
 * the framing lives.
 *
 * Over the cap the decoder yields a FATAL result: the error goes back as a
 * JSON-RPC frame and the connection closes. There is no recovering mid-line —
 * the framing is already lost, so continuing would just resynchronize on
 * whatever byte followed.
 */

import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@agentick/gateway";
import { ErrorCode } from "@agentick/spec";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_LINE_BYTES, NdjsonDecoder, encodeNdjson } from "../shared/ndjson.js";
import { unixSocketServer, type UnixSocketServerHandle } from "../server/index.js";

const dirs: string[] = [];
const servers: UnixSocketServerHandle[] = [];
const sockets: Socket[] = [];
const gateways: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (sockets.length) sockets.pop()!.destroy();
  while (servers.length) await servers.pop()!.close();
  while (gateways.length) await gateways.pop()!.close();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentick-uds-cap-"));
  dirs.push(dir);
  return join(dir, "test.sock");
}

describe("NdjsonDecoder — frame-size cap", () => {
  it("REFUSES a line past the cap with a fatal result", () => {
    const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
    const results = decoder.push("x".repeat(100));

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    const failure = results[0] as { ok: false; error: { code: number }; fatal?: boolean };
    expect(failure.error.code).toBe(ErrorCode.InvalidRequest);
    expect(failure.fatal).toBe(true);
  });

  it("counts bytes ACROSS chunks — no single chunk has to exceed the cap", () => {
    const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
    // Ten 10-byte chunks, none of them over the cap on its own.
    const results = Array.from({ length: 10 }).flatMap(() => decoder.push("y".repeat(10)));

    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { fatal?: boolean }).fatal).toBe(true);
  });

  it("does NOT accumulate across frames — the count resets at each newline", () => {
    const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
    const frame = encodeNdjson({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(frame.length).toBeLessThan(64);

    // Far more total bytes than the cap, but no single LINE is over it.
    const results = Array.from({ length: 20 }).flatMap(() => decoder.push(frame));

    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(20);
  });

  it("measures BYTES, not characters — multibyte text counts what it costs", () => {
    // Each "é" is 2 UTF-8 bytes: 40 characters, 80 bytes.
    const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
    const results = decoder.push(Buffer.from("é".repeat(40), "utf8"));

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
  });

  it("refuses ONCE per oversized line, then resynchronizes at the next newline", () => {
    const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
    expect(decoder.push("z".repeat(100)).filter((r) => !r.ok)).toHaveLength(1);

    // More of the doomed line: already refused, so no second error and no
    // attempt to parse from the middle of it.
    expect(decoder.push("z".repeat(200))).toEqual([]);

    // The newline ends the doomed line; the frame after it decodes normally.
    const clean = encodeNdjson({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
    const resumed = decoder.push(`\n${clean}`);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.ok).toBe(true);
  });

  it("a frame at exactly the cap is ACCEPTED — the bound is inclusive", () => {
    const payload = { jsonrpc: "2.0" as const, id: 1, method: "ping" as const, params: {} };
    const line = encodeNdjson(payload);
    const decoder = new NdjsonDecoder({ maxLineBytes: Buffer.byteLength(line) });
    const results = decoder.push(line);

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });

  it("the default cap is generous but finite", () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
    // A default-constructed decoder is bounded, not unbounded.
    const decoder = new NdjsonDecoder();
    expect(decoder.push("hello").filter((r) => !r.ok)).toEqual([]);
  });
});

describe("unix socket server — frame-size cap", () => {
  it("CLOSES the connection on an oversized line, after reporting it", async () => {
    const path = socketPath();
    const gateway = await createGateway();
    gateways.push(gateway);
    const server = unixSocketServer({ path, gateway, maxLineBytes: 1_024 });
    servers.push(server);
    await server.listening();

    const socket = connect(path);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const received: string[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    // A newline-less flood. Unbounded, this grows the server's buffer forever.
    socket.write("A".repeat(4_096));

    await closed;

    // The peer learns why before the socket goes away.
    const body = received.join("");
    expect(body).toContain("too large");

    socket.destroy();
  });

  it("a normal-sized frame still round-trips under a cap", async () => {
    const path = socketPath();
    const gateway = await createGateway();
    gateways.push(gateway);
    const server = unixSocketServer({ path, gateway, maxLineBytes: 1_024 });
    servers.push(server);
    await server.listening();

    const socket = connect(path);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const response = new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    });
    socket.write(encodeNdjson({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }));

    expect(JSON.parse(await response)).toMatchObject({ jsonrpc: "2.0", id: 7, result: {} });
    socket.destroy();
  });
});
