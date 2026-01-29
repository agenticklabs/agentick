# V2 Compiler Tests

Comprehensive test suite for the V2 Fiber Compiler.

## Test Files

### `hooks.spec.ts`

Tests for all hook implementations:

- **State Hooks**: `useState`, `useReducer`, `useSignal`
- **COM Hooks**: `useComState`, `useWatch`, `useInput`
- **Effect Hooks**: `useEffect`, `useOnMount`, `useOnUnmount`
- **Lifecycle Hooks**: `useTickStart`, `useTickEnd`, `useAfterCompile`
- **Memoization**: `useMemo`, `useCallback`
- **Refs**: `useRef`, `useCOMRef`
- **Utilities**: `useAsync`, `usePrevious`, `useToggle`, `useCounter`
- **Hook Rules**: Validation that hooks are called correctly

### `fiber-compiler.spec.ts`

Tests for the main compiler:

- **Basic Compilation**: Simple JSX, function components, class components
- **Function Components with Hooks**: Components using useState, useComState
- **Class Components**: Lifecycle methods, signals, props
- **Content Blocks**: Pure content block objects, arrays
- **Effect Phases**: Tick start, tick end, mount effects
- **Compile Stabilization**: Recompile loops, max iterations
- **Unmounting**: Cleanup for both function and class components
- **Tools**: Tool collection from Tool components
- **Sections**: Section merging, visibility, audience
- **Messages**: User and system messages
- **Props Updates**: Updating props for function and class components

### `fiber.spec.ts`

Tests for fiber utilities:

- **Fiber Creation**: `createFiber`, `createWorkInProgress`, `cloneFiber`
- **Tree Traversal**: `getChildFibers`, `findFiberByKey`, `traverseFiber`, `traverseFiberBottomUp`
- **Hook Utilities**: `getHookCount`, `getHookAtIndex`
- **Debug Utilities**: `fiberToDebugString`, `fiberTreeToDebugString`

### `integration.spec.ts`

End-to-end integration tests:

- **Mixed Components**: Function and class components together
- **State Management**: State updates, COM state sync
- **Lifecycle Integration**: Correct order of lifecycle hooks
- **Content Collection**: Timeline entries, sections
- **Error Handling**: Component errors, effect errors
- **Unmounting**: Resource cleanup
- **Reconciliation**: Fiber reuse, key changes
- **Props Updates**: Function and class component props

## Running Tests

```bash
# Run all V2 compiler tests
npm test -- compiler

# Run specific test file
npm test -- hooks.spec.ts
npm test -- fiber-compiler.spec.ts
npm test -- fiber.spec.ts
npm test -- integration.spec.ts

# Run with coverage
npm test -- --coverage compiler
```

## Test Coverage Goals

- ✅ All hooks implemented and tested
- ✅ Basic compilation scenarios
- ✅ Function components with hooks
- ✅ Class components with lifecycle
- ✅ Effect phases (mount, tickStart, tickEnd, commit)
- ✅ Compile stabilization
- ✅ Content block handling
- ✅ Fiber reconciliation
- ✅ Props updates
- ✅ Unmounting and cleanup
- ✅ Error handling
- ✅ Integration scenarios

## Writing New Tests

When adding new features, follow these patterns:

```typescript
describe('Feature Name', () => {
  let com: COM;
  let compiler: FiberCompilerV2;
  let tickState: TickState;

  beforeEach(() => {
    com = new ContextObjectModel();
    compiler = new FiberCompilerV2(com);
    tickState = {
      tick: 1,
      stop: vi.fn(),
    } as TickState;
  });

  it('should do something', async () => {
    // Arrange
    const element = createElement(MyComponent, {});

    // Act
    const result = await compiler.compile(element, tickState);

    // Assert
    expect(result).toBeDefined();
  });
});
```

## Key Testing Patterns

### Testing Hooks

```typescript
setRenderContext(renderContext);
const [value, setValue] = useState(0);
expect(value).toBe(0);
```

### Testing Effects

```typescript
const spy = vi.fn();
useEffect(spy, []);
// Effects run during commit phase
await compiler.compile(element, tickState);
expect(spy).toHaveBeenCalled();
```

### Testing Lifecycle

```typescript
await compiler.notifyTickStart(tickState);
expect(tickStartSpy).toHaveBeenCalled();
```

### Testing Compile Stabilization

```typescript
const result = await compiler.compileUntilStable(element, tickState);
expect(result.iterations).toBeGreaterThan(1);
```
