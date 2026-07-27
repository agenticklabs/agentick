/**
 * The HTML/SVG-colliding content-block wrappers — `<Text>` `<Code>` `<Image>`
 * `<Audio>` `<Video>` — produce IR byte-identical to the lowercase intrinsics
 * they wrap. Those intrinsics cannot be declared in the JSX namespace (React
 * pre-types the tag names), so the wrappers are the ONLY typed authoring path;
 * before this file they were referenced by jsx-intrinsics.ts as "the
 * recommended path" without existing.
 *
 * Collection rig is the same one content-blocks.spec.tsx uses.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import {
  collect,
  createBuiltInRegistry,
  createContainer,
  createHostScope,
} from "@agentick/compiler";

import { createCompiler } from "../react/compiler.js";
import { Audio, Code, Image, Text, Video } from "../index.js";

function renderAndCollect(element: React.ReactNode) {
  const container = createContainer({
    mountId: "wrap",
    rootScope: createHostScope({ formatter: { id: "markdown", format: "markdown" } }),
  });
  const compiler = createCompiler({ container, idPrefix: "wrap" });
  compiler.render(element, compiler.createRoot());
  const registry = createBuiltInRegistry();
  return collect({ roots: container.children, registry, rootScope: container.rootScope }).tree;
}

const inMessage = (child: React.ReactElement) =>
  React.createElement("message", { role: "user" }, child);

const png = { type: "url", url: "https://x.test/a.png" } as const;

describe("content-block wrappers — byte-identity with the intrinsics", () => {
  const cases: ReadonlyArray<[React.ReactElement, string, Record<string, unknown>]> = [
    [React.createElement(Text, { text: "hi" }), "text", { text: "hi" }],
    [
      React.createElement(Code, { language: "ts", text: "let x = 1;" }),
      "code",
      { language: "ts", text: "let x = 1;" },
    ],
    [React.createElement(Image, { source: png }), "image", { source: png }],
    [React.createElement(Audio, { source: png }), "audio", { source: png }],
    [React.createElement(Video, { source: png }), "video", { source: png }],
  ];

  for (const [element, tag, props] of cases) {
    it(`the ${tag} wrapper IS <${tag}> — same collected tree`, () => {
      const viaWrapper = renderAndCollect(inMessage(element));
      const viaIntrinsic = renderAndCollect(inMessage(React.createElement(tag, props)));
      expect(viaWrapper).toEqual(viaIntrinsic);
      // Non-vacuity: the block really collected, typed.
      expect(JSON.stringify(viaWrapper.context.entries)).toContain(`"type":"${tag}"`);
    });
  }
});
