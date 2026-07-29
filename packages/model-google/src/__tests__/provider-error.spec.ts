/**
 * Google's error envelope → a sentence a human can act on.
 *
 * `GoogleGenAI` puts a SERIALIZED envelope in `Error.message`, and that envelope's own
 * `error.message` is frequently another serialized envelope. Nothing unwrapped it, so a
 * bad request reached the caller's `SendResult`, the durable turn boundary, and the
 * chat panel as ~250 characters of escaped JSON with eight useful words in the middle.
 *
 * The framework already had the seam — `LanguageModelAdapter.mapProviderError`,
 * documented as "override when your provider surfaces structured errors you can extract
 * more detail from". Google surfaces them; this adapter simply never took it.
 *
 * The fixture below is a verbatim capture from a live Vertex rejection.
 */

import { describe, expect, it } from "vitest";
import { ProviderRejected } from "@agentick/spec";

import { mapProviderError } from "../google-adapter.js";

/** Verbatim from a live 400. Doubly serialized, exactly as the SDK hands it over. */
const NESTED_400 =
  '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": ' +
  '\\"Request contains an invalid argument.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n",' +
  '"code":400,"status":"Bad Request"}}';

describe("mapProviderError — the deepest message wins", () => {
  it("extracts the provider's sentence from a doubly-serialized envelope", () => {
    const mapped = mapProviderError(new Error(NESTED_400));
    expect(mapped).toBeInstanceOf(ProviderRejected);
    // The eight words that were buried. NOT the outer "Bad Request", which is a
    // transport restatement — the inner layer is the provider's actual complaint.
    expect(mapped.message).toContain("Request contains an invalid argument.");
    expect(mapped.message).not.toContain("\\n");
    expect(mapped.message).not.toContain('{"error"');
  });

  it("keeps the status CLASS, which the sentence usually omits", () => {
    // "Request contains an invalid argument." does not say which argument, or what kind
    // of problem it is. `INVALID_ARGUMENT` is the searchable half.
    expect(mapProviderError(new Error(NESTED_400)).message).toContain("[INVALID_ARGUMENT]");
  });

  it("carries the numeric code as the HTTP status", () => {
    const mapped = mapProviderError(new Error(NESTED_400));
    expect((mapped as ProviderRejected).status).toBe(400);
    // …and the composed message still ends with it, from `ProviderRejected` itself.
    expect(mapped.message).toContain("(status=400)");
  });

  it("keeps the RAW envelope on `cause` — nothing is lost, only unburied", () => {
    const raw = new Error(NESTED_400);
    expect(mapProviderError(raw).cause).toBe(raw);
  });

  it("handles a SINGLY-wrapped envelope too", () => {
    const mapped = mapProviderError(
      new Error('{"error":{"code":429,"message":"Quota exceeded.","status":"RESOURCE_EXHAUSTED"}}'),
    );
    expect(mapped.message).toContain("Quota exceeded.");
    expect(mapped.message).toContain("[RESOURCE_EXHAUSTED]");
    expect((mapped as ProviderRejected).status).toBe(429);
  });

  it("falls back to StreamFailed when there is nothing structured to extract", () => {
    // A non-JSON failure (a socket hangup, a DNS error) is NOT a provider rejection.
    // Dressing it as one would misreport a network fault as the model refusing.
    expect(mapProviderError(new Error("socket hang up"))._tag).toBe("StreamFailed");
    expect(mapProviderError(undefined)._tag).toBe("StreamFailed");
  });

  it("terminates on adversarial nesting rather than spinning", () => {
    // The unwrap is depth-bounded. A payload whose `message` is always another
    // envelope must not be able to loop — this one nests further than the bound.
    let payload = '{"error":{"code":400,"message":"innermost","status":"X"}}';
    for (let i = 0; i < 12; i += 1) {
      payload = JSON.stringify({ error: { code: 400, message: payload } });
    }
    const mapped = mapProviderError(new Error(payload));
    // It stops early and reports the deepest layer it reached — a truthful partial
    // answer beats hanging the executor.
    expect(mapped).toBeInstanceOf(ProviderRejected);
    expect((mapped as ProviderRejected).status).toBe(400);
  });
});
