/**
 * ElicitationHarness — pending-ask enumeration (§6.1, the live-only defect fix).
 *
 * The `session:channel:elicitation` request channel becomes SNAPSHOT-FIRST: the
 * harness implements {@link ChannelSnapshotProvider}, so a client subscribing
 * MID-ASK receives the outstanding prompt in frame one instead of nothing.
 * These prove the harness half:
 *
 *   - `snapshotChannel` names the channel; the harness is a provider.
 *   - `channelSnapshotPayload()` enumerates every in-flight elicit as a
 *     discriminated `kind: "snapshot"` frame whose entries mirror the live
 *     request delta (correlationId / replyTo / payload) — the mid-ask proof.
 *   - a resolved ask leaves the pending set (the frame shrinks).
 *
 * The full open-with-snapshot wiring (session bridge scan → `sub/subscribe`
 * prepend) is proven in `@agentick/session` + `@agentick/gateway`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@agentick/utils/testing";
import { isChannelSnapshotProvider, jsonSchema, type StandardSchemaV1 } from "@agentick/spec";

import { ELICITATION_CHANNEL } from "../channel.js";
import { fakeElicitation, type FakeElicitationBundle } from "../testing/fake-elicitation.js";

function lenientObject(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return jsonSchema<Record<string, unknown>>(
    { type: "object", additionalProperties: true },
    {
      validator: (raw) =>
        raw !== null && typeof raw === "object"
          ? { value: raw as Record<string, unknown> }
          : { issues: [{ message: "expected an object" }] },
    },
  );
}

describe("ElicitationHarness — pending-ask snapshot (§6.1)", () => {
  let bundle: FakeElicitationBundle | undefined;
  afterEach(async () => {
    await bundle?.close();
    bundle = undefined;
  });

  it("is a ChannelSnapshotProvider for the elicitation channel", async () => {
    bundle = await fakeElicitation();
    expect(isChannelSnapshotProvider(bundle.harness)).toBe(true);
    expect(bundle.harness.snapshotChannel).toBe(ELICITATION_CHANNEL);
    // Nothing pending → an empty, well-formed snapshot frame.
    expect(bundle.harness.channelSnapshotPayload()).toEqual({ kind: "snapshot", requests: [] });
  });

  it("MID-ASK: a request in flight appears in the snapshot frame, mirroring the live delta", async () => {
    bundle = await fakeElicitation();
    const { harness } = bundle;

    // Raise an ask but do NOT await it — it stays pending on the registry.
    void harness.elicit({ message: "pick a fruit", schema: lenientObject() });
    await waitFor(() => harness.pendingCount() === 1);

    const frame = harness.channelSnapshotPayload();
    expect(frame.kind).toBe("snapshot");
    expect(frame.requests).toHaveLength(1);

    const [req] = frame.requests;
    // The entry carries the SAME correlation fields a subscriber reads off a
    // live request delta (`metadata.correlationId` / `.replyTo`) plus the wire
    // payload (`envelope.payload`) — a seeded subscriber matches a live one.
    expect(typeof req!.correlationId).toBe("string");
    expect(req!.correlationId.startsWith("req:")).toBe(true);
    expect(req!.replyTo).toBe(harness.address);
    expect(req!.payload).toMatchObject({ mode: "form", message: "pick a fruit" });

    // The frame carries NO metadata.requestType — today's request-only client
    // fold skips it (additive), which is why this is safe to prepend.
  });

  it("enumerates MULTIPLE concurrent asks oldest-first", async () => {
    bundle = await fakeElicitation();
    const { harness } = bundle;

    void harness.elicit({ message: "first", schema: lenientObject() });
    await waitFor(() => harness.pendingCount() === 1);
    void harness.elicit({ message: "second", schema: lenientObject() });
    await waitFor(() => harness.pendingCount() === 2);

    const frame = harness.channelSnapshotPayload();
    expect(frame.requests.map((r) => (r.payload as { message: string }).message)).toEqual([
      "first",
      "second",
    ]);
  });

  it("drops a resolved ask from the snapshot (the pending set shrinks)", async () => {
    bundle = await fakeElicitation();
    const { harness } = bundle;

    const pending = harness.elicit({ message: "confirm?", schema: lenientObject() });
    await waitFor(() => harness.pendingCount() === 1);

    const correlationId = harness.channelSnapshotPayload().requests[0]!.correlationId;
    await harness.respond({ correlationId, outcome: "accepted", value: { ok: true } });
    await pending;

    await waitFor(() => harness.pendingCount() === 0);
    expect(harness.channelSnapshotPayload()).toEqual({ kind: "snapshot", requests: [] });
  });
});
