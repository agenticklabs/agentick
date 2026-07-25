/**
 * The naive coding agent — a JSX component. This is the entire "user surface":
 * a system prompt, the coding tools, one runtime knob, and the timeline. No
 * substrate (journal, bus, inbox) appears here.
 *
 * The prompt tone (ACT don't narrate; list → grep → read; edit over write;
 * verify) is adapted from the tentickle v1 coding agent.
 */

import React from "react";
import { System } from "@agentick/compiler-react-next";
import { Knobs, useKnob } from "@agentick/knobs-next/react";
import { Timeline } from "@agentick/timeline-next/react";

import { ReadFile, ListDir, Grep, WriteFile, RunShell } from "./tools.js";

export function CodingAgent(): React.ReactElement {
  // A model-visible, model-settable, CLIENT-settable knob. The agent re-renders
  // when it flips (from the model's knob_set tool OR the client's
  // session.knobs.set(...)), and the system prompt below changes with it.
  const [explainSteps] = useKnob<boolean>("explainSteps", false, {
    description: "When true, narrate the plan before acting and explain each step.",
    valueType: "boolean",
  });

  return (
    <>
      <System>
        You are a naive but careful coding agent working inside a scratch workspace. You have tools
        to read, list, search, write files, and run shell commands.
        {"\n\n"}
        CORE RULES:
        {"\n"}- ACT, don't narrate. Don't say "I'll read the file" — call read_file. Use a tool in
        every step until the task is done, then give a one-line summary.
        {"\n"}- Navigate before you read: list_dir / grep to locate, then read_file the specific
        file.
        {"\n"}- write_file is DESTRUCTIVE and asks the user for approval every time — use it only
        for new files or full rewrites, and only when needed.
        {"\n"}- Use run_shell for git, tests, builds, and to verify your work (e.g. run the file you
        just wrote).
        {explainSteps
          ? "\n\nEXPLAIN MODE: briefly state your plan before the first tool call, and note what each result tells you."
          : "\n\nBe terse — let the tool calls speak; summarize at the end in one or two sentences."}
      </System>

      {/* Tools — registered with the session's tool executor at mount. */}
      <ReadFile.Tool />
      <ListDir.Tool />
      <Grep.Tool />
      <WriteFile.Tool />
      <RunShell.Tool />

      {/* knob_set tool + the current knob values, rendered as a Section the
          model sees. The `explainSteps` knob above shows up here. */}
      <Knobs />

      {/* THE CONVERSATION — the timeline reaches the model only because this
          renders it into the tree. */}
      <Timeline />
    </>
  );
}
