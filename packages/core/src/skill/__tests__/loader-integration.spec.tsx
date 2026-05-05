/**
 * Integration: file-loaded skill executed via session.skill().
 *
 * Verifies the full path: load .md from disk → invoke via session.skill
 * with a caller-provided result schema → typed structured output.
 */

import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { loadSkill } from "../loader.js";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";

describe("file-loaded skill + session.skill", () => {
  it("loads a skill from disk and runs it with a caller-typed result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-int-"));
    try {
      const path = join(dir, "triage.md");
      await writeFile(
        path,
        `---
name: triage
description: Investigate an issue
maxTicks: 5
---
You are a triage agent. Investigate the issue and call submit.`,
      );

      const Triage = await loadSkill(path);

      const model = createTestAdapter({ defaultResponse: "ok" });
      function Agent() {
        return (
          <>
            <Model model={model} />
            <System>Test</System>
            <Timeline />
          </>
        );
      }
      const app = createApp(Agent, { maxTicks: 5 });
      const session = await app.session();

      model.respondWith([
        { tool: { name: "submit", input: { fixApplied: true, severity: "low" } } },
      ]);

      const result = await session.skill(Triage, {
        args: { issueNumber: 42 },
        result: z.object({ fixApplied: z.boolean(), severity: z.string() }),
      });

      expect(result).toEqual({ fixApplied: true, severity: "low" });

      await session.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
