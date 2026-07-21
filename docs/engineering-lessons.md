# Engineering Lessons

This document records prevention rules derived from production defects. Treat each
applicable rule as a release-blocking acceptance criterion, not as guidance.

## Runtime adapters must preserve the handler contract

When `extensions/embedded-server.ts` routes are invoked through Bun's Fetch
adapter, request and response objects are not Node `IncomingMessage` and
`ServerResponse` instances. A handler MUST NOT call Node EventEmitter methods
such as `once()` or `removeListener()` unless the adapter provides them.

- Define the smallest shared contract at the boundary.
- Prefer standard `AbortSignal` cancellation for Fetch paths; support Node event
  lifecycle only as an optional compatibility path.
- Test every new or changed HTTP route through the production Fetch adapter shape,
  in addition to testing extracted helpers.
- Include already-aborted requests and cleanup paths in cancellation tests.
- A route exception that can terminate the embedded server is a session-loading
  regression and MUST have an end-to-end smoke check.

## Prototypes are UI contracts, not inspiration

A supplied visual prototype is binding for the described surface. Before coding,
turn it into explicit, testable requirements:

- visible rows, labels, icons, separators, spacing, truncation, and controls;
- API fields intentionally omitted from the UI;
- localized text and accessible names; and
- loading, empty, error, and viewport-clamping states.

The design spec MUST state those requirements. DOM tests MUST assert the
structural contract. For popup, overlay, or other appearance-sensitive work, a
real browser screenshot or interaction check against the prototype is REQUIRED;
unit tests alone are insufficient.

## Shared-state rerenders must preserve transient UI deliberately

A Pin mutation can synchronously rerender the sidebar while a quick-info card is
open. Any renderer that replaces DOM MUST explicitly decide what happens to an
open overlay, focused control, hover target, pending request, and scroll/fold
state.

- Preserve an open card when the same logical workspace is recreated.
- Rebind the card to the replacement header before the old DOM is discarded.
- Test the complete sequence: open overlay → mutate shared state → rerender →
  verify visibility, target data, focus behavior, and action state.
- Only close transient UI when the underlying logical target disappeared or the
  product specification says to close it.

## Required evidence before completion

For a change spanning frontend, embedded server, or persistence:

1. Run focused behavior tests for each changed boundary.
2. Run the full test suite and the project formatter/linter check.
3. Exercise the real affected path in the development app when it crosses the
   browser/server adapter or changes visible UI.
4. Record any intentionally retained API/UI difference in both the feature design
   spec and `ARCHITECTURE.md`.
