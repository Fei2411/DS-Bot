# Contribution proposal — stability and safety hardening for native Harness integrations

Dear maintainers,

We would like to contribute a set of stability and safety improvements developed while running DS Bot with several native Harnesses. This pull request is the proposal stage: it groups the changes by function, records how each one was verified, and states the compatibility constraints. The implementation patches will be submitted in small, function-scoped batches after the direction is confirmed, so that each batch can be rebased onto the current branch cleanly.

The full draft and the patch inventory are published in the contributor's public repository: https://github.com/Evergre7n/MOSS

## 1. ACP session isolation and effort injection

- **Issue:** one stalled ACP session could affect others; the ACP engine did not forward a thinking level.
- **Change:** one child process per ACP session; inject the thinking level after model selection.
- **Verification:** cold-start and multi-session runs; Node test runner where applicable.
- **Compatibility:** opt-in; no protocol change.

## 2. Error normalization and observability

- **Issue:** numeric ACP error codes were surfaced as one generic error message, hiding timeouts, content review and busy sessions behind the same text.
- **Change:** map upstream error messages to stable string codes; keep the numeric code in the payload for JSON-RPC clients; optional trace capture.
- **Verification:** reproduced timeout, busy and review cases and confirmed distinct codes.
- **Compatibility:** additive; existing error handling unchanged when disabled.

## 3. Credential minimization and headless child processes

- **Issue:** account references could be persisted in harness configuration; child processes could open console windows on Windows.
- **Change:** pass credential variable names only, never values; reject retired runtime dependencies; enforce hidden child windows.
- **Verification:** configuration audit and windowless process self-check.
- **Compatibility:** opt-in allow-list; credentials remain in each Harness's native store.

## 4. MCP stdio bridge and protocol purity

- **Issue:** loopback HTTP MCP needed a stdio front-end; diagnostics could pollute the JSON-RPC stdout stream.
- **Change:** stdio bridge with loopback-only URL validation, token handling and a bounded request timeout; silence SDK console output.
- **Verification:** GET, POST and SSE round trips; stdout cleanliness check.
- **Compatibility:** new module; no change to existing transports.

## 5. Constitution gate coverage

- **Issue:** full-text rules were not delivered consistently across native routes and direct API agents.
- **Change:** in-memory request-copy injection bound to agent, context, model and content hash; per-route hooks for native Harnesses.
- **Verification:** route-by-route delivery tests and tool interception while pending.
- **Compatibility:** no change to stored conversations or group messages.

## 6. Reproducible package patches

- **Issue:** hot patches to the packaged host needed a verifiable before-and-after record.
- **Change:** manifest with SHA-256 of each patched file before and after; a small repack helper.
- **Verification:** hash re-computation against the packaged files.
- **Compatibility:** patches are version-specific (packaged 0.3.2) and must be rebased onto the current branch before merge.

## Validation checklist

- [ ] Node test runner on gate module tests
- [ ] ACP cold-start and busy-session reproduction
- [ ] Windowless child process self-check
- [ ] MCP stdio round trip (GET / POST / SSE)
- [ ] Hash verification of patched files

## Additional finding

A separate bug report on an intermittent team-state write failure on Windows is included in this proposal (`BUG-REPORT-state-write-eperm.md`). It is reported because the failure changed a tool call's reported result while the UI side effect succeeded; the suggested fixes are listed in that file.

## Disclosure note

All absolute local paths in the original integration are parameterized into configuration keys and environment variables before any code is submitted. No credentials, account identifiers, conversation data, machine-specific paths or internal project names are included in this contribution, and no materials reference or link to any private repository.

Thank you for your time and for maintaining DS Bot. We would be glad to adjust the patch set to match the project's conventions.
