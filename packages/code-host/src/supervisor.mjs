// @ts-check
/**
 * The child half of `@agentick/code-host`: one long-lived process per context,
 * running whatever JS engine the host app runs.
 *
 * Plain JavaScript with no imports beyond `node:fs`, because this file is
 * spawned as a script by an engine that is not necessarily the one that
 * compiled the package — a bare specifier here would have to resolve inside
 * whatever placement the child was put in.
 *
 * Framing: ndjson, parent→child on stdin, child→parent on fd 3. The program's
 * own stdout and stderr stay the real fds 1 and 2, so nothing it prints can
 * reach the channel that carries answers.
 */

import { writeSync } from "node:fs";

const CONTROL_FD = 3;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** @type {Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>} */
const awaitingBinding = new Map();
/** The ambient names, already built: proxies grafted into the value tree, frozen. */
/** @type {Record<string, unknown>} */
let context = {};
let nextCallId = 0;

/** @param {Record<string, unknown>} frame */
function send(frame) {
  writeSync(CONTROL_FD, `${JSON.stringify(frame)}\n`);
}

/** A named async function in the program's scope: one frame out, one frame back. */
function bindingProxy(name) {
  return (input) =>
    new Promise((resolve, reject) => {
      const callId = ++nextCallId;
      awaitingBinding.set(callId, { resolve, reject });
      send({ t: "call", callId, name, input });
    });
}

/**
 * Rebuild the context the caller described: the value tree with a proxy grafted
 * in at each function's dotted path, then frozen so a program cannot swap what
 * it was handed. `__proto__` is skipped — the harness already refuses it, and
 * this is the one place a raw caller could pollute a prototype through a path.
 */
function buildContext(tree, fns) {
  for (const path of fns) {
    const segments = path.split(".");
    const leaf = segments.pop();
    let cursor = tree;
    for (const segment of segments) {
      if (segment === "__proto__") return tree;
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) cursor[segment] = {};
      cursor = cursor[segment];
    }
    if (leaf !== "__proto__") cursor[leaf] = bindingProxy(path);
  }
  for (const entry of Object.values(tree)) deepFreeze(entry);
  return tree;
}

function deepFreeze(node) {
  if (typeof node !== "object" || node === null || Object.isFrozen(node)) return;
  for (const entry of Object.values(node)) deepFreeze(entry);
  Object.freeze(node);
}

/**
 * The answer has to cross as JSON. A value that cannot is a MEMBRANE failure,
 * not a program that threw — reporting it as `threw` would tell the model its
 * code was wrong.
 */
function marshalValue(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    return { outcome: "unmarshalable", detail: String(cause) };
  }
  if (json === undefined)
    return { outcome: "unmarshalable", detail: `${typeof value} is not JSON` };
  return { outcome: "returned", value };
}

function marshalError(err) {
  const error = { message: String(err instanceof Error ? err.message : err) };
  if (err instanceof Error) {
    if (err.name) error.name = err.name;
    if (err.stack) error.stack = err.stack;
  }
  return { outcome: "threw", error };
}

/**
 * Hand the queued writes to the OS before the answer goes out, so the parent's
 * one-turn wait is enough for the last bytes to land on fds 1 and 2.
 */
function flushed(stream) {
  return new Promise((resolve) => stream.write("", () => resolve(undefined)));
}

async function exec(id, source) {
  let body;
  try {
    const program = new AsyncFunction(...Object.keys(context), source);
    const value = await program(...Object.values(context));
    body = value === undefined ? { outcome: "no-value" } : marshalValue(value);
  } catch (err) {
    body = marshalError(err);
  }
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  send({ t: "done", id, ...body });
}

function receive(frame) {
  switch (frame.t) {
    case "init":
      context = buildContext(frame.values, frame.fns);
      send({ t: "ready" });
      return;
    case "exec":
      void exec(frame.id, frame.source);
      return;
    case "call-return": {
      const waiting = awaitingBinding.get(frame.callId);
      if (waiting === undefined) return;
      awaitingBinding.delete(frame.callId);
      if (frame.ok) waiting.resolve(frame.value);
      else waiting.reject(new Error(frame.error));
      return;
    }
  }
}

let inbound = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inbound += chunk;
  for (let at = inbound.indexOf("\n"); at >= 0; at = inbound.indexOf("\n")) {
    const line = inbound.slice(0, at);
    inbound = inbound.slice(at + 1);
    if (line.length > 0) receive(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

/**
 * A program's abandoned async work must not take the context down with it: the
 * conversation continues, and the error is something the next program's author
 * can read on stderr.
 */
const strayWork = (err) => {
  process.stderr.write(`[code-host] stray async work failed: ${String(err)}\n`);
};
process.on("unhandledRejection", strayWork);
process.on("uncaughtException", strayWork);
