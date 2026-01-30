# @tentickle/react Architecture

React bindings are thin wrappers around `@tentickle/client`.

## Hooks

- `useSession(sessionId, { autoSubscribe })` → session accessor
- `useEvents(handler)` → global multiplexed events
- `useConnection()` → read-only connection state

## Notes

- No `useResult` or `useChannel` hooks (use session accessor instead)
- No manual `connect()`/`disconnect()` in the React API
