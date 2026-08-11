/**
 * `fakeCodeHarness()` — a real {@link CodeHarness} on an in-memory substrate.
 *
 * The harness is the production class; only the journal, bus and inbox are
 * local. Omit `runtime` to get the INERT harness — the state a session carries
 * before an adopter binds a provider.
 *
 * The default id carries a generated suffix so concurrent calls cannot collide
 * on the inbox address (`code:<harnessId>`).
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";

import { CodeHarness, type CodeHarnessOptions } from "../harness.js";

export interface FakeCodeHarnessOptions extends CodeHarnessOptions {
  readonly harnessId?: string;
}

export interface FakeCodeHarnessBundle {
  readonly harness: CodeHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  close: () => Promise<void>;
}

export async function fakeCodeHarness(
  options: FakeCodeHarnessOptions = {},
): Promise<FakeCodeHarnessBundle> {
  const { harnessId = `fake-code-${generateId()}`, ...rest } = options;
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new CodeHarness(harnessId, journal, bus, inbox, rest);
  await harness.ready;
  return { harness, journal, bus, inbox, close: () => harness.close() };
}
