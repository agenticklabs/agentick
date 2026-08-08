/**
 * `fakeCompletions()` — working in-memory harness for tests.
 *
 * Returns a real {@link CompletionsHarness} wired to `MemoryJournal`,
 * `LocalEventBus`, `LocalInbox`. Consumers exercising the harness in tests hit
 * the same code path the production substrate does — the only difference is the
 * substrate is in-memory. The `journal` is handed back because the
 * no-journaling-per-keystroke invariant is asserted against it.
 *
 * **Unique default id.** The default `harnessId` carries a ULID suffix to
 * prevent inbox-address collisions across concurrent `fakeCompletions()` calls
 * (each registers on `completions:<harnessId>`).
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { CompletionsHarness, type CompletionsHarnessOptions } from "../harness.js";

export interface FakeCompletionsOptions extends CompletionsHarnessOptions {
  readonly harnessId?: string;
}

export interface FakeCompletionsBundle {
  readonly harness: CompletionsHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  /** Convenience close — also stops the harness's inbox subscription. */
  close: () => Promise<void>;
}

export async function fakeCompletions(
  options: FakeCompletionsOptions = {},
): Promise<FakeCompletionsBundle> {
  const { harnessId = `fake-completions-${generateId()}`, ...rest } = options;
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new CompletionsHarness(harnessId, journal, bus, inbox, rest);
  await harness.ready;
  return { harness, journal, bus, inbox, close: () => harness.close() };
}
