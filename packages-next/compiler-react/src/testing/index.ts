/**
 * Test-only surface for `@agentick/compiler-react-next`.
 *
 * Adopters writing tests against templates that register intrinsics
 * should import `clearRegisteredIntrinsics` from this subpath to
 * reset the global registry between test cases.
 *
 * Production code SHOULD NOT import from `/testing` — clearing the
 * registry mid-app wipes legitimate plugin-package registrations.
 */

export { clearRegisteredIntrinsics } from "../register-intrinsic.js";
