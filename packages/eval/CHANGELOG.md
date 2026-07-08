# @agentick/eval

## 0.15.3

### Patch Changes

- 70c886e: New package: `@agentick/eval` — testing-shaped eval framework (port of the v2 `eval-next` sketch onto v1 core APIs).

  `defineEval({ description, app, test })` returns a callable eval; `.matrix(axes)` runs cartesian parameter sweeps — the same inputs and expectations across multiple models — with per-cell results. Assertions record instead of throwing (`completed`, `calledTool`, `notCalledTool`, `noFailedActions`), plus two v1 extensions: `t.send` accepts content blocks (attach documents/images), and `t.expect(name, passed, opts?)` records custom assertions for expected-output scoring, with `t.lastToolCall(name)` for reading a submit tool's payload.

- Updated dependencies [43550df]
  - @agentick/core@0.15.3
