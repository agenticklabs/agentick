/**
 * Runs the shared `runResourcesHarnessConformance` suite against the
 * real `ResourcesHarness` over an in-memory substrate (`fakeResources`).
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { runResourcesHarnessConformance } from "../conformance.js";
import { ResourcesHarness } from "../harness.js";

runResourcesHarnessConformance(
  "ResourcesHarness (memory substrate)",
  async ({ harnessId, pageSize }) => {
    const harness = new ResourcesHarness(
      harnessId,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { pageSize },
    );
    await harness.ready;
    return { harness, close: () => harness.close() };
  },
);
