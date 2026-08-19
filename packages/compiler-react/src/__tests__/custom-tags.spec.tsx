import { describe, expect, it } from "vitest";
import React from "react";
import {
  createContainer,
  createHostScope,
  collect,
  createBuiltInRegistry,
} from "@agentick/compiler";
import { createCompiler } from "../react/compiler.js";

/**
 * Application-defined tags — the custom-elements rule at the adopter's entry
 * point: hyphenated JSX intrinsics typecheck without any declaration and
 * lower to `<custom>` blocks. This is the exact authoring shape that
 * motivated the feature (a RAG context component writing
 * `<relevant-context>` and having it vanish into passthrough).
 */

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "ct",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "ct" });
  const root = compiler.createRoot();
  compiler.render(element, root);
  return collect({
    roots: container.children,
    registry: createBuiltInRegistry(),
    rootScope: container.rootScope,
  });
}

describe("hyphenated intrinsics are application-defined tags", () => {
  it("leaf custom tag typechecks and lowers with tag + stringified attrs", () => {
    const { tree } = renderAndCollect(
      <message role="user">
        <relevant-context source="rag" limit={3}>
          the retrieved facts
        </relevant-context>
      </message>,
    );
    expect(tree.context.entries[0]!.content[0]).toMatchObject({
      type: "custom",
      tag: "relevant-context",
      content: "the retrieved facts",
      attrs: { source: "rag", limit: "3" },
    });
  });

  it("nested custom tags survive as structure through the full JSX pipeline", () => {
    const { tree } = renderAndCollect(
      <message role="user">
        <relevant-context source="rag">
          <about-user name="ryan">prefers terse</about-user>
        </relevant-context>
      </message>,
    );
    const block = tree.context.entries[0]!.content[0] as {
      semanticNode?: { children?: readonly unknown[] };
    };
    expect(block.semanticNode?.children?.[0]).toMatchObject({
      semantic: "custom",
      props: { tag: "relevant-context", attrs: { source: "rag" } },
    });
  });
});
