/**
 * A custom tag nests. Its children used to be flattened by `collectText`, so
 * only the outermost tag survived and everything inside became bare words —
 * which made the one construct meant for explicit boundaries unable to express
 * more than one.
 */
import React from "react";
import { describe, expect, it } from "vitest";

import { Section, renderTemplate } from "../index.js";

describe("nested custom tags", () => {
  it("keeps every level, with attributes", async () => {
    const { output } = await renderTemplate(
      <Section id="rc">
        <custom tag="retrieved-context">
          <custom tag="about">system-produced</custom>
          <custom tag="result" attrs={{ rank: "1", title: "Cabin & <job>" }}>
            retainage is 10%
          </custom>
        </custom>
      </Section>,
    );

    expect(output).toContain("<retrieved-context>");
    expect(output).toContain("<about>system-produced</about>");
    expect(output).toContain('<result rank="1" title="Cabin &amp; &lt;job&gt;">');
    expect(output).toContain("retainage is 10%");
  });

  it("still emits the flat block form for a leaf", async () => {
    const { output } = await renderTemplate(
      <Section id="rc">
        <custom tag="memory-kind" attrs={{ kind: "episodic" }}>
          recall
        </custom>
      </Section>,
    );
    expect(output).toContain('<memory-kind kind="episodic">recall</memory-kind>');
  });

  it("honours an explicit content prop over children", async () => {
    const { output } = await renderTemplate(
      <Section id="rc">
        <custom tag="x" content="explicit">
          <custom tag="ignored">nope</custom>
        </custom>
      </Section>,
    );
    expect(output).toContain("<x>explicit</x>");
    expect(output).not.toContain("<ignored>");
  });
});
