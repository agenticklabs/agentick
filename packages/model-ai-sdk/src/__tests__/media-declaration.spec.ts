/**
 * `aisdk()` declares NO `capabilities.media`, and that is the intended answer.
 *
 * The other three adapters know their provider and can state per modality which
 * `MediaSource` kinds reach the wire. This one is a meta-adapter over an arbitrary AI
 * SDK provider: `aiSDKFileData` forwards every kind as an opaque string, and whether
 * the provider behind it accepts a `gs://` URI or a bare file id is unknowable from
 * here. Declaring support would be a claim it cannot make; declaring the empty set
 * would drop media that works today.
 *
 * So absence carries meaning, and the meaning is load-bearing enough to pin: an absent
 * declaration means UNDECLARED — `applyMediaSupport` screens nothing and behaviour is
 * exactly as before. If it ever read as "carries nothing", every request through this
 * adapter would silently lose its attachments.
 */

import { describe, expect, it } from "vitest";

import { aisdk } from "../ai-sdk-adapter.js";

describe("aisdk() adapter — media support is deliberately undeclared", () => {
  it("declares no capabilities.media, so nothing is screened", () => {
    expect(aisdk("openai/gpt-4o").target.capabilities?.media).toBeUndefined();
  });

  it("still declares the capabilities it CAN speak to", () => {
    // Absence is specific to media, not a generally empty capability bag — otherwise
    // "undeclared" would be indistinguishable from "never populated".
    const capabilities = aisdk("openai/gpt-4o").target.capabilities;
    expect(capabilities?.supportsTools).toBe(true);
    expect(capabilities?.supportsStreaming).toBe(true);
  });
});
