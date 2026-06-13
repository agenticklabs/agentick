import { describe } from "vitest";
import { runInboxConformance } from "@agentick/spec-conformance-next";
import { LocalInbox } from "../substrate/local-inbox.js";

describe("LocalInbox — conformance", () => {
  runInboxConformance(() => new LocalInbox());
});
