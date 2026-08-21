/**
 * `buildSessionElicit` — the schema each sugar method puts on the wire.
 *
 * The defect these lock down: the sugar used to build validate-only
 * Standard Schemas, so `toJsonSchema()` fell through to the degenerate
 * `{ type: "object" }` and every in-process ask reached the client
 * shapeless. `select`/`multiSelect` also dropped `labels` entirely.
 *
 * Each case asserts the CLIENT-FACING payload (`payload.schema`, read off
 * the `session:channel:elicitation` request envelope — the exact object a
 * subscriber renders from) and then completes the round-trip through
 * `harness.respond()`, so the value-level contract is verified end to end:
 * the schema describes the bare value the client accepts with.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import { jsonSchema } from "@agentick/spec";
import type { Elicit, ProtocolEvent, StandardSchemaV1 } from "@agentick/spec";
import type { LocalEventBus } from "@agentick/runtime";

import { ELICITATION_CHANNEL_FQN } from "../channel.js";
import { buildSessionElicit } from "../elicit-sugar.js";
import { fakeElicitation, type FakeElicitationBundle } from "../testing/fake-elicitation.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** Resolves with the next request envelope. Subscribe BEFORE eliciting. */
function nextRequestEnvelope(bus: LocalEventBus): Promise<EnvelopeWithMetadata> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: ELICITATION_CHANNEL_FQN },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
}

const bundles: FakeElicitationBundle[] = [];

afterEach(async () => {
  while (bundles.length > 0) await bundles.pop()!.close();
});

interface Fixture {
  readonly elicit: Elicit;
  readonly bus: LocalEventBus;
  readonly harness: FakeElicitationBundle["harness"];
}

async function withElicit(): Promise<Fixture> {
  const bundle = await fakeElicitation();
  bundles.push(bundle);
  return {
    elicit: buildSessionElicit({ harness: bundle.harness }),
    bus: bundle.bus,
    harness: bundle.harness,
  };
}

/**
 * Drive one sugar call until its request is on the wire, accept it with
 * `value`, and hand back both the schema the client saw and the settled
 * call. Settled rather than awaited: a schema violation rejects, and that
 * is one of the things under test.
 */
async function ask<T>(
  fixture: Fixture,
  call: (elicit: Elicit) => Promise<T>,
  value: unknown,
): Promise<{ schema: Record<string, unknown>; result: PromiseSettledResult<T> }> {
  const envP = nextRequestEnvelope(fixture.bus);
  // Settle eagerly so a rejection is never momentarily unhandled while we
  // read the wire.
  const settled = Promise.allSettled([call(fixture.elicit)]);
  const env = await envP;
  const payload = env.payload as { schema: Record<string, unknown> };
  await fixture.harness.respond({
    correlationId: env.metadata!.correlationId as string,
    outcome: "accepted",
    value,
  });
  return { schema: payload.schema, result: (await settled)[0]! };
}

function rejectionText(result: PromiseSettledResult<unknown>): string {
  return result.status === "rejected" ? String(result.reason) : `<fulfilled: ${String(result)}>`;
}

// ---------------------------------------------------------------------------
// text / number / confirm / boolean
// ---------------------------------------------------------------------------

describe("elicit sugar — the wire schema carries the real flat shape", () => {
  it("text: type + format + pattern + length bounds + default", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) =>
        e.text("Your email?", {
          format: "email",
          pattern: "^.+@.+$",
          minLength: 3,
          maxLength: 64,
          default: "a@b.co",
        }),
      "someone@example.com",
    );

    expect(schema).toEqual({
      type: "string",
      default: "a@b.co",
      pattern: "^.+@.+$",
      format: "email",
      minLength: 3,
      maxLength: 64,
    });
    expect(result).toEqual({ status: "fulfilled", value: "someone@example.com" });
  });

  it("text: a bare call is a plain string field — no invented keys", async () => {
    const f = await withElicit();
    const { schema } = await ask(f, (e) => e.text("Name?"), "ada");
    expect(schema).toEqual({ type: "string" });
  });

  it("number: minimum + maximum + default, and `integer` picks the integer type", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) => e.number("How many?", { min: 1, max: 10, integer: true, default: 3 }),
      7,
    );

    expect(schema).toEqual({ type: "integer", minimum: 1, maximum: 10, default: 3 });
    expect(result).toEqual({ status: "fulfilled", value: 7 });
  });

  it("number: non-integer asks are type:'number'", async () => {
    const f = await withElicit();
    const { schema } = await ask(f, (e) => e.number("Ratio?", { min: 0 }), 0.5);
    expect(schema).toEqual({ type: "number", minimum: 0 });
  });

  it("confirm: boolean field carrying the default", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(f, (e) => e.confirm("Proceed?", { default: true }), true);
    expect(schema).toEqual({ type: "boolean", default: true });
    expect(result).toEqual({ status: "fulfilled", value: true });
  });

  it("boolean: same field shape as confirm", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) => e.boolean("Enabled?", { default: false }),
      false,
    );
    expect(schema).toEqual({ type: "boolean", default: false });
    expect(result).toEqual({ status: "fulfilled", value: false });
  });
});

// ---------------------------------------------------------------------------
// select / multiSelect — including the dropped-labels defect
// ---------------------------------------------------------------------------

describe("elicit sugar — enums project choices and labels", () => {
  it("select: enum + default, and `labels` becomes positional enumNames", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) =>
        e.select("Pick a tier", ["free", "pro", "team"] as const, {
          default: "pro",
          labels: { free: "Free forever", pro: "Pro ($20/mo)" },
        }),
      "team",
    );

    expect(schema).toEqual({
      type: "string",
      enum: ["free", "pro", "team"],
      default: "pro",
      // Unlabelled choices fall back to the raw option, keeping the array
      // positionally aligned with `enum`.
      enumNames: ["Free forever", "Pro ($20/mo)", "team"],
    });
    expect(result).toEqual({ status: "fulfilled", value: "team" });
  });

  it("select: no labels → no enumNames key", async () => {
    const f = await withElicit();
    const { schema } = await ask(f, (e) => e.select("Pick", ["a", "b"] as const), "a");
    expect(schema).toEqual({ type: "string", enum: ["a", "b"] });
    expect(schema).not.toHaveProperty("enumNames");
  });

  it("multiSelect: array of enum items + minItems/maxItems/default + item enumNames", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) =>
        e.multiSelect("Pick regions", ["us", "eu", "ap"] as const, {
          min: 1,
          max: 2,
          default: ["us"],
          labels: { us: "United States", eu: "Europe" },
        }),
      ["us", "eu"],
    );

    expect(schema).toEqual({
      type: "array",
      items: {
        type: "string",
        enum: ["us", "eu", "ap"],
        enumNames: ["United States", "Europe", "ap"],
      },
      uniqueItems: true,
      default: ["us"],
      minItems: 1,
      maxItems: 2,
    });
    expect(result).toEqual({ status: "fulfilled", value: ["us", "eu"] });
  });

  it("try* variants send the same schema as their throwing twins", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(
      f,
      (e) => e.trySelect("Pick", ["x", "y"] as const, { labels: { x: "Ex" } }),
      "y",
    );
    expect(schema).toEqual({ type: "string", enum: ["x", "y"], enumNames: ["Ex", "y"] });
    expect(result).toEqual({ status: "fulfilled", value: { status: "accept", value: "y" } });
  });
});

// ---------------------------------------------------------------------------
// The validators survive the rewrite — accept round-trip still enforced
// ---------------------------------------------------------------------------

describe("elicit sugar — accepted values are still validated", () => {
  it("text: a value under minLength fails the ask rather than resolving", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.text("At least 5 chars", { minLength: 5 }), "abc");
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("number: a value above `max` fails the ask", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.number("1-10", { max: 10 }), 99);
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("select: a value outside the enum fails the ask", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.select("Pick", ["a", "b"] as const), "c");
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("confirm: a non-boolean reply fails the ask", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.confirm("Sure?"), "yes");
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("multiSelect: a non-member item fails the ask", async () => {
    const f = await withElicit();
    const { result } = await ask(
      f,
      (e) => e.tryMultiSelect("Pick", ["a", "b"] as const, { min: 1 }),
      ["a", "zzz"],
    );
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("multiSelect: a legal set resolves", async () => {
    const f = await withElicit();
    const { result } = await ask(
      f,
      (e) => e.tryMultiSelect("Pick", ["a", "b"] as const, { min: 1 }),
      ["a"],
    );
    expect(result).toEqual({ status: "fulfilled", value: { status: "accept", value: ["a"] } });
  });
});

// ---------------------------------------------------------------------------
// form — the whole-object ask the single-field helpers are shortcuts over
// ---------------------------------------------------------------------------

interface Person {
  readonly name: string;
  readonly age: number;
}

const PERSON_SHAPE = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "number" } },
  required: ["name", "age"],
} as const;

/** A caller-supplied (e.g. model-authored) object schema, validator and all. */
function personSchema(): StandardSchemaV1<unknown, Person> {
  return jsonSchema<Person>(PERSON_SHAPE, {
    vendor: "test:person",
    validator: (raw) => {
      const o = raw as Record<string, unknown>;
      if (typeof o?.name !== "string") return { issues: [{ message: "name must be a string" }] };
      if (typeof o?.age !== "number") return { issues: [{ message: "age must be a number" }] };
      return { value: { name: o.name, age: o.age } };
    },
  });
}

describe("elicit sugar — form() carries a whole-object schema", () => {
  it("sends the object schema verbatim and round-trips the whole value", async () => {
    const f = await withElicit();
    const { schema, result } = await ask(f, (e) => e.form("Who are you?", personSchema()), {
      name: "Ada",
      age: 36,
    });
    expect(schema).toEqual(PERSON_SHAPE);
    expect(result).toEqual({ status: "fulfilled", value: { name: "Ada", age: 36 } });
  });

  it("validates the accepted object — a bad field fails the ask, it does not resolve", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.form("Who?", personSchema()), {
      name: "Ada",
      age: "old",
    });
    expect(rejectionText(result)).toContain("schema_violation");
  });

  it("tryForm returns an accept outcome carrying the object", async () => {
    const f = await withElicit();
    const { result } = await ask(f, (e) => e.tryForm("Who?", personSchema()), {
      name: "Grace",
      age: 40,
    });
    expect(result).toEqual({
      status: "fulfilled",
      value: { status: "accept", value: { name: "Grace", age: 40 } },
    });
  });
});
