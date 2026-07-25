/**
 * `fakeElicitation()` — working in-memory harness for tests.
 *
 * Returns a real {@link ElicitationHarness} wired to `MemoryJournal`,
 * `LocalEventBus`, `LocalInbox`. Consumers exercising the harness in
 * tests get the same code path the production substrate hits — the
 * only difference is the substrate is in-memory.
 *
 * **Unique default id.** The default `harnessId` carries a ULID
 * suffix to prevent inbox-address collisions across concurrent
 * `fakeElicitation()` calls (each registers on
 * `elicitation:<harnessId>`; duplicates fail at inbox-registration).
 */

import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  ulid,
  type CommandHooks,
} from "@agentick/runtime";
import { ElicitationHarness, type ElicitationHarnessOptions } from "../harness.js";

export interface FakeElicitationOptions extends ElicitationHarnessOptions {
  readonly harnessId?: string;
  /**
   * Declarative command hooks (ADR 83) registered on the harness after
   * construction via `harness.hook(...)` — the runtime twin of the app/session
   * `hooks` config. `onBeforeElicitationElicit` / `onAfterElicitationElicit` /
   * `onElicitationElicit` wrap the elicit round-trip op.
   */
  readonly hooks?: CommandHooks;
}

export interface FakeElicitationBundle {
  readonly harness: ElicitationHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  /** Convenience close — also stops the harness's inbox subscription. */
  close: () => Promise<void>;
}

export async function fakeElicitation(
  options: FakeElicitationOptions = {},
): Promise<FakeElicitationBundle> {
  const { harnessId = `fake-elicitation-${ulid()}`, hooks, ...rest } = options;
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new ElicitationHarness(harnessId, journal, bus, inbox, rest);
  if (hooks) harness.hook(hooks);
  await harness.ready;
  return {
    harness,
    journal,
    bus,
    inbox,
    close: () => harness.close(),
  };
}
