/**
 * `agentick/no-floating-run-promise` — the editor-time half of #315's fix.
 *
 * A floating `Effect.runPromise(...)` — `void`-discarded or a bare
 * expression statement, `.catch`-chained or not — is banned everywhere
 * except `run-detached.ts`: `runDetached` is the one sanctioned way to run
 * a fire-and-forget Effect, because it routes failure to a sink instead of
 * Node's process-killing unhandled-rejection default.
 *
 * `scripts/detached-effect-gate.mjs` enforces the same invariant at
 * publish time; this rule surfaces it while the code is being written.
 * Assigned, awaited, returned, or argument-position runPromise calls are
 * fine — someone observes those.
 */

function isRunPromiseChain(expr) {
  let node = expr;
  while (node) {
    if (node.type === "ChainExpression") {
      node = node.expression;
      continue;
    }
    if (node.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return false;
    if (
      callee.object.type === "Identifier" &&
      callee.object.name === "Effect" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "runPromise"
    ) {
      return true;
    }
    // A `.then(...)` / `.catch(...)` link — keep descending to the chain base.
    node = callee.object;
  }
  return false;
}

function isExemptFile(filename) {
  const posix = filename.split("\\").join("/");
  return (
    posix.endsWith("/run-detached.ts") ||
    /\.spec\.[cm]?tsx?$/.test(posix) ||
    posix.includes("/__tests__/")
  );
}

const rule = {
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isExemptFile(filename)) return {};

    const report = (node) => {
      context.report({
        message:
          "Floating Effect.runPromise — an unobserved rejection kills the process (#315). " +
          "Use runDetached (@agentick/runtime), or await/assign the promise.",
        node,
      });
    };

    return {
      ExpressionStatement(node) {
        if (node.expression.type === "UnaryExpression") return; // handled below
        if (isRunPromiseChain(node.expression)) report(node.expression);
      },
      UnaryExpression(node) {
        if (node.operator !== "void") return;
        if (isRunPromiseChain(node.argument)) report(node);
      },
    };
  },
};

export default rule;
