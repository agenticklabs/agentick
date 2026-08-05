/**
 * `google()`'s `capabilities.media` declaration, bound to what it actually puts on the
 * wire. The framework enforces the declaration, so a declaration that drifts from this
 * adapter's real projection silently drops media that works — or forwards media that gets
 * rejected, which is the bug that started all of this.
 *
 * No Gemini-shaped assertions here any more: `detectDroppedInputs` answers "did this reach
 * the wire" generically, so the hand-written `inlineData` / `fileData` predicate this file
 * used to carry is gone.
 */

import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@agentick/spec";

import { runMediaDeclarationCheck } from "@agentick/model/testing";

import { google } from "../google-adapter.js";

runMediaDeclarationCheck(google("gemini-2.0-flash"));

/**
 * `gs://` is a VERTEX capability, not a Google one, and this adapter fronts both
 * endpoints. Declaring the union was wrong for whichever was configured: against
 * the Gemini / Agent Platform endpoint every bucket URI came back
 *
 *   Referencing Google Cloud Storage files directly is not supported.
 *   Register them using FileService.RegisterFile first.
 *
 * The framework enforces the declaration, so an honest one turns a provider
 * rejection into a stated decline — and a decline tells an adopter to resolve
 * the reference to something else first, which is the actual fix.
 */
describe("the gs: scheme follows the ENDPOINT, not the provider name", () => {
  const schemesOf = (adapter: { target: ExecutionTarget }) =>
    adapter.target.capabilities?.media?.urlSchemes ?? [];

  it("Vertex declares gs: — it reads Cloud Storage natively, zero bytes moved", () => {
    const vertex = google("gemini-2.0-flash", {
      clientOptions: { vertexai: true, project: "p", location: "us-central1" },
    });
    expect(schemesOf(vertex)).toContain("gs");
  });

  it("the API-key endpoint does NOT — it refuses a bucket URI outright", () => {
    const direct = google("gemini-2.0-flash", { clientOptions: { apiKey: "k" } });
    expect(schemesOf(direct)).not.toContain("gs");
    // The universally fetchable closure survives; only the bucket scheme goes.
    expect(schemesOf(direct)).toEqual(["https", "http", "data"]);
  });

  it("project/location alone is enough — the same signal the client is built from", () => {
    // `buildClientOptions` treats project/location as choosing Vertex even
    // without an explicit `vertexai: true`, and the declaration reads the same
    // reconciliation so the two cannot disagree about which endpoint is called.
    const inferred = google("gemini-2.0-flash", {
      clientOptions: { project: "p", location: "us-central1" },
    });
    expect(schemesOf(inferred)).toContain("gs");
  });
});
