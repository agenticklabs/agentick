/**
 * `fakeResources()` — working in-memory harness for tests.
 *
 * Returns a real {@link ResourcesHarness} wired to `MemoryJournal`,
 * `LocalEventBus`, `LocalInbox`. Consumers exercising the harness in
 * tests hit the same code path the production substrate does — the only
 * difference is the substrate is in-memory.
 *
 * **Unique default id.** The default `harnessId` carries a ULID suffix
 * to prevent inbox-address collisions across concurrent `fakeResources()`
 * calls (each registers on `resources:<harnessId>`).
 */

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { ResourcesHarness, type ResourcesHarnessOptions } from "../harness.js";

export interface FakeResourcesOptions extends ResourcesHarnessOptions {
  readonly harnessId?: string;
}

export interface FakeResourcesBundle {
  readonly harness: ResourcesHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  /** Convenience close — also stops the harness's inbox subscription. */
  close: () => Promise<void>;
}

export async function fakeResources(
  options: FakeResourcesOptions = {},
): Promise<FakeResourcesBundle> {
  const { harnessId = `fake-resources-${generateId()}`, ...rest } = options;
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new ResourcesHarness(harnessId, journal, bus, inbox, rest);
  await harness.ready;
  return {
    harness,
    journal,
    bus,
    inbox,
    close: () => harness.close(),
  };
}
