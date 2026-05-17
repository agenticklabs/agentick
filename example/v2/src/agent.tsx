/**
 * The example agent — a JSX-defined "support agent" that exposes a
 * calculator + a few diagnostic tools. The reconciler harness mounts
 * this tree and produces a `RenderedTree` ready for the executor harness
 * (Phase 4c) to send to a model.
 *
 * The shape of this file is the canonical user surface — JSX components
 * for context, declarations for tools, hooks for reactive state. None of
 * the substrate (journal, bus, inbox, FiberRef) appears here.
 */

import { H2, Message, Paragraph, Section, System, Text, Tool } from "./components.js";

export function SupportAgent() {
  return (
    <>
      <System>
        <Paragraph>
          You are a helpful support agent. Use the calculator for arithmetic
          and the diagnostic tools when asked to introspect.
        </Paragraph>
      </System>

      <Section id="capabilities" title="Capabilities" audience="model">
        <H2>Available tools</H2>
        <Paragraph>
          <Text>calculator — evaluate arithmetic expressions</Text>
        </Paragraph>
        <Paragraph>
          <Text>whoami — surface the current session scope</Text>
        </Paragraph>
        <Paragraph>
          <Text>slow — sleep for N ms; cancellable via abort</Text>
        </Paragraph>
      </Section>

      <Tool
        id="t.calculator"
        name="calculator"
        description="Evaluate arithmetic expressions"
        inputSchema={{
          type: "object",
          required: ["expression"],
          properties: {
            expression: { type: "string", description: "A JS arithmetic expression" },
          },
        }}
        exposure={["model"]}
        handlerRef="handlers/calculator"
      />

      <Tool
        id="t.whoami"
        name="whoami"
        description="Return the current session scope from the harness-supplied ctx"
        inputSchema={{ type: "object", properties: {} }}
        exposure={["model"]}
        handlerRef="handlers/whoami"
      />

      <Tool
        id="t.effect-whoami"
        name="effect-whoami"
        description="Return the current session scope via getContext — Effect-typed handler"
        inputSchema={{ type: "object", properties: {} }}
        exposure={["model"]}
        handlerRef="handlers/effect-whoami"
      />

      <Tool
        id="t.slow"
        name="slow"
        description="Sleep for N ms then return; cancellable via abort"
        inputSchema={{
          type: "object",
          properties: { ms: { type: "number", default: 1000 } },
        }}
        exposure={["model"]}
        handlerRef="handlers/slow"
      />

      <Tool
        id="t.progress"
        name="progress"
        description="Emit channel events as it works — demonstrates ctx.emit + LocalChannelPublisher"
        inputSchema={{
          type: "object",
          properties: { steps: { type: "number", default: 3 } },
        }}
        exposure={["model"]}
        handlerRef="handlers/progress"
      />

      <Tool
        id="t.explode"
        name="explode"
        description="Always throws — used to demonstrate terminal:failed envelopes"
        inputSchema={{ type: "object", properties: {} }}
        exposure={["model"]}
        handlerRef="handlers/explode"
      />

      <Message role="user">What's 47 * 23?</Message>
    </>
  );
}
