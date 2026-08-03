/**
 * `<Event>` — the `event`-role sugar, and the shape an event is authored in.
 *
 * The design claim under test: an event carries STRUCTURE, and the formatter
 * derives its text. Authoring `text` by hand freezes a rendering into the
 * durable timeline, so the props form has to reach the model on its own.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { fakeBridges } from "@agentick/compiler";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { Event } from "../react/components/semantic.js";
import { Text } from "../react/components/content-blocks.js";
import { Message } from "../react/components/message.js";

let seq = 0;

async function renderEntry(element: React.ReactElement): Promise<{
  readonly role: string;
  readonly content: readonly { type: string; text?: string }[];
}> {
  const harness = new CompilerHarness(
    `h_evt_${seq}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  const mountId = `m_evt_${seq++}`;
  await harness.mount({ mountId, sessionId: "s", element, bridges: fakeBridges() });
  const { tree } = await harness.renderTree({ mountId, sessionId: "s" });
  const entry = tree.context.entries[0];
  if (entry === undefined) throw new Error("no context entries produced");
  return entry as unknown as {
    role: string;
    content: readonly { type: string; text?: string }[];
  };
}

const textOf = (entry: { content: readonly { text?: string }[] }): string =>
  entry.content.map((b) => b.text ?? "").join("");

describe("<Event> is event-role sugar", () => {
  it("produces the event role", async () => {
    const entry = await renderEntry(
      <Event>
        <Text text="something happened" />
      </Event>,
    );
    expect(entry.role).toBe("event");
  });

  it("is byte-identical to <Message role='event'>", async () => {
    const sugar = await renderEntry(
      <Event>
        <Text text="same" />
      </Event>,
    );
    const explicit = await renderEntry(
      <Message role="event">
        <Text text="same" />
      </Message>,
    );
    expect(sugar.role).toBe(explicit.role);
    expect(textOf(sugar)).toBe(textOf(explicit));
  });
});

describe("a structured event reaches the model without hand-written text", () => {
  it("the data bag renders", async () => {
    const entry = await renderEntry(
      <Event>
        <system_event
          event="compaction"
          source="timeline"
          data={{ summary: "Discussed the store substrate." }}
        />
      </Event>,
    );
    expect(textOf(entry)).toContain("Discussed the store substrate.");
    expect(textOf(entry)).toContain('event="compaction"');
  });

  it("state_change carries its diff through", async () => {
    const entry = await renderEntry(
      <Event>
        <state_change entity="task" field="status" from="working" to="completed" />
      </Event>,
    );
    expect(textOf(entry)).toContain("<from>working</from>");
    expect(textOf(entry)).toContain("<to>completed</to>");
  });
});
