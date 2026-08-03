/**
 * `<XML>` / `<Markdown>` change the dialect of the subtree they wrap.
 *
 * They quietly did nothing through `renderTemplate`: an unsupplied `formatter`
 * option was substituted with markdown and passed as the PIN, and a pin
 * overrides every declared `renderedWith` and disables islands outright. The
 * compiler had been stamping the scope correctly the whole time.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { xmlFormatter } from "@agentick/formatters";

import { Section, XML, Markdown, renderTemplate } from "../index.js";

const tree = (
  <Section id="s" title="Things">
    <ul>
      <li>alpha</li>
    </ul>
  </Section>
);

describe("FormatScope", () => {
  it("renders the subtree as XML", async () => {
    const { output } = await renderTemplate(<XML>{tree}</XML>);
    expect(output).toContain("<things>");
    expect(output).toContain("<ul><li>alpha</li></ul>");
  });

  it("leaves the default alone", async () => {
    const { output } = await renderTemplate(tree);
    expect(output).toContain("# Things");
    expect(output).toContain("- alpha");
  });

  it("an explicit formatter still PINS, overriding a declared dialect", async () => {
    // Naming one means "this dialect, everywhere" — the island is deliberately
    // not honoured, or the caller who asked for exactly one format loses.
    const { output } = await renderTemplate(<Markdown>{tree}</Markdown>, {
      formatter: xmlFormatter,
    });
    expect(output).toContain("<things>");
  });

  it("nests — the inner scope wins", async () => {
    const { output } = await renderTemplate(
      <XML>
        <Markdown>{tree}</Markdown>
      </XML>,
    );
    expect(output).toContain("# Things");
  });
});
