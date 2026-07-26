# @agentick/spec

## 1.0.0-next.2

### Patch Changes

- Shared-server citizenship for the HTTP and WebSocket server transports:
  attached ({ httpServer }) transports now ignore non-matching requests
  and upgrades instead of 404ing/destroying them, so they coexist with
  the adopter's routes and other websocket consumers (e.g. socket.io) on
  one Node server. Owned ({ port }) behavior unchanged.
