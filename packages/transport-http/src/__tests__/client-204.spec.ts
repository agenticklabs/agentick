/**
 * A `204 No Content` response body is never read.
 *
 * The server answers `204` to every notification `POST` — `notifications/
 * cancelled` is the one the client itself sends, on every aborted request. The
 * early-return guard for that case read `!response.ok && response.status === 204`,
 * which is unsatisfiable: `204` IS `ok`. So the client fell through to
 * `response.json()` on a body that is empty by definition, took the parse
 * throw, and swallowed it — a thrown exception per cancellation, and a "no
 * content" response treated as a frame source.
 *
 * The observable: the `204` response's body stays untouched (`bodyUsed` false,
 * `json()` never called). Driven through the public surface with a `fetch`
 * override — a first-class option on this transport.
 */

import { waitFor } from "@agentick/utils/testing";
import { describe, expect, it } from "vitest";

import { http } from "../client/index.js";

interface Recorded {
  /** Each `204` the client received, so the test can inspect what was read. */
  readonly noContent: Response[];
  /** How many times `json()` was invoked on a `204`. */
  jsonReads: number;
  cancelPosts: number;
}

/**
 * A `fetch` standing in for the real server: an open SSE stream on `GET`, a
 * `204` for the notification `POST` the abort produces, and an id-less `200`
 * for anything else (so the RPC stays pending and the abort has something to
 * cancel).
 */
function recordingFetch(rec: Recorded): typeof globalThis.fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      // Never-ending SSE body: the client's notification stream stays open.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("notifications/cancelled")) {
      rec.cancelPosts += 1;
      const res = new Response(null, { status: 204 });
      const original = res.json.bind(res);
      Object.defineProperty(res, "json", {
        value: async () => {
          rec.jsonReads += 1;
          return original();
        },
      });
      rec.noContent.push(res);
      return res;
    }

    // A frame with no `id` — routed nowhere, so the RPC stays pending.
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("HTTP client — 204 No Content", () => {
  it("never reads the body of a 204", async () => {
    const rec: Recorded = { noContent: [], jsonReads: 0, cancelPosts: 0 };
    const transport = http({ url: "http://127.0.0.1:1/", fetch: recordingFetch(rec) });
    await transport.connect();

    const controller = new AbortController();
    const settled = transport
      .request("ping", {}, controller.signal)
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const);
    controller.abort();
    expect(await settled).toBe("rejected");

    await waitFor(() => rec.cancelPosts >= 1, { description: "the cancellation POST" });

    expect(rec.jsonReads).toBe(0);
    // Native proof, independent of the spy: nothing consumed the stream.
    expect(rec.noContent.map((r) => r.bodyUsed)).toEqual([false]);

    await transport.close();
  });

  it("stays open and keeps serving after a 204", async () => {
    const rec: Recorded = { noContent: [], jsonReads: 0, cancelPosts: 0 };
    const transport = http({ url: "http://127.0.0.1:1/", fetch: recordingFetch(rec) });
    await transport.connect();

    const controller = new AbortController();
    void transport.request("ping", {}, controller.signal).catch(() => {});
    controller.abort();
    await waitFor(() => rec.cancelPosts >= 1, { description: "the cancellation POST" });

    expect(transport.state).toBe("open");
    await transport.close();
  });
});
