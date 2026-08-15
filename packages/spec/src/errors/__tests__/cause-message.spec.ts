/**
 * A wrapping error's `message` must be USEFUL.
 *
 * `message` is what every consumer reads: a log line, a telemetry attribute, an
 * eval score, a UI. `_tag` already carries the classification, so a message that
 * only restates the classification buys nothing — and buries the one sentence that
 * explains the failure.
 *
 * `ProviderRejected` was the single error in the executor family that did this. Its
 * siblings — `StreamFailed`, `NormalizationFailed`, `ProjectionFailed`,
 * `UnknownExecutorError` — all inline their cause. And `ProviderRejected` is the
 * wrapper the loop puts around a failed stream, so the informative message went in
 * and `"provider rejected"` came out. Observed live: a Google adapter died with
 *
 *   Project/location and API key are mutually exclusive in the client initializer.
 *
 * and every surface in the system — the resolved `SendResult`, the turn boundary,
 * the panel — reported "provider rejected". The real sentence was two levels down
 * in `cause`, reachable only by a consumer that knew to walk it. One fact, and every
 * consumer would have needed its own walker.
 */

import { describe, expect, it } from "vitest";

import {
  causeMessage,
  MalformedModelOutput,
  ProviderRejected,
  StreamFailed,
  UnknownExecutorError,
} from "../harnesses.js";

describe("ProviderRejected — the cause's words survive the wrapping", () => {
  it("adopts a nested error's message instead of restating its own tag", () => {
    const inner = new StreamFailed({
      cause: new Error("Project/location and API key are mutually exclusive"),
    });
    const wrapped = new ProviderRejected({ cause: inner });

    expect(wrapped.message).toContain("mutually exclusive");
    // The classification lives on `_tag` — the grep key — not in the prose. A
    // prefix here would stack "provider rejected: provider stream failed: …" on a
    // chain that is already nested.
    expect(wrapped.message.startsWith("provider rejected")).toBe(false);
    expect(wrapped._tag).toBe("ProviderRejected");
  });

  it("keeps the bare classification when the cause has nothing to say", () => {
    // The honest message when there is genuinely no detail — not an empty string,
    // and not a fabricated explanation.
    expect(new ProviderRejected().message).toBe("provider rejected");
    expect(new ProviderRejected({ cause: {} }).message).toBe("provider rejected");
    expect(new ProviderRejected({ cause: new Error("") }).message).toBe("provider rejected");
  });

  it("keeps the status, which is diagnostic on its own", () => {
    expect(new ProviderRejected({ status: 429 }).message).toBe("provider rejected (status=429)");
    expect(new ProviderRejected({ status: 401, cause: "invalid api key" }).message).toBe(
      "invalid api key (status=401)",
    );
  });

  it("survives serialization — this is what crosses the wire", () => {
    // The whole point: `SerializedAgentickError.message` is what a client renders.
    const wrapped = new ProviderRejected({ cause: new Error("region refused the request") });
    const json = wrapped.toJSON();
    expect(json._tag).toBe("ProviderRejected");
    expect(json.message).toBe("region refused the request");
  });

  it("the CHAIN is still there — adopting a message does not flatten the evidence", () => {
    const inner = new StreamFailed({ cause: new Error("socket hangup") });
    const wrapped = new ProviderRejected({ cause: inner });
    expect(wrapped.cause).toBe(inner);
  });
});

describe("MalformedModelOutput — the same fold, minus the model's own words", () => {
  it("adopts the cause's message and names the tool", () => {
    const err = new MalformedModelOutput({
      toolName: "knowify__query",
      cause: new SyntaxError("Unexpected end of JSON input"),
    });
    expect(err.message).toBe("Unexpected end of JSON input (tool=knowify__query)");
    expect(err._tag).toBe("MalformedModelOutput");
  });

  it("keeps the bare classification when the cause has nothing to say", () => {
    expect(new MalformedModelOutput().message).toBe("malformed model output");
    expect(new MalformedModelOutput({ toolName: "t1" }).message).toBe(
      "malformed model output (tool=t1)",
    );
  });

  it("REDACTS rawArguments from the projection — model output may carry user data", () => {
    const err = new MalformedModelOutput({
      toolName: "knowify__query",
      rawArguments: '{"ssn":"078-05-1120',
      cause: new SyntaxError("Unexpected end of JSON input"),
    });
    // Readable in-process, where the operator debugging the run already holds
    // the data; gone from the shape that crosses a wire or lands in a log.
    expect(err.rawArguments).toBe('{"ssn":"078-05-1120');
    const json = err.toJSON();
    expect("rawArguments" in json).toBe(false);
    expect(JSON.stringify(err)).not.toContain("078-05-1120");
    expect(json.toolName).toBe("knowify__query");
  });
});

describe("causeMessage — one format for every wrapper", () => {
  it("reads an Error's message, a string as itself", () => {
    expect(causeMessage(new Error("boom"))).toBe("boom");
    expect(causeMessage("boom")).toBe("boom");
  });

  it("returns undefined for anything with nothing to say", () => {
    // `String({})` is `"[object Object]"`, which is worse than no detail: it looks
    // like an explanation and is not one.
    for (const empty of [undefined, null, "", {}, new Error("")]) {
      expect(causeMessage(empty)).toBeUndefined();
    }
  });

  it("is NOT applied by the base class — a redacted cause must stay redacted", () => {
    // A `cause` may carry secrets, which is why some subclasses filter it out of
    // `toJSON()`. Folding a cause into `message` — always serialized — would defeat
    // that, so the decision belongs to the wrapper, which knows what its cause is.
    // `UnknownExecutorError` inlines via `String(cause)` and is untouched here.
    expect(new UnknownExecutorError({ cause: "weird" }).message).toBe(
      "unknown executor error: weird",
    );
  });
});
