# Patch inventory (grouped by function)

| # | Function | Files (relative names) | Validation |
| --- | --- | --- | --- |
| 1 | ACP session isolation and effort injection | `acp-effort.mjs`, `minimax-acp-effort.mjs`, `harness-launch.mjs` | cold-start and multi-session runs |
| 2 | Error normalization and observability | error mapping in `acp-effort.mjs`, optional trace capture | reproduced timeout, busy and review cases |
| 3 | Credential minimization and headless child processes | `harness-launch.mjs`, headless child guard modules | configuration audit and windowless self-check |
| 4 | MCP stdio bridge and protocol purity | `mcp-stdio-bridge.mjs` | GET, POST and SSE round trips |
| 5 | Constitution gate coverage | gate core and host module, per-route hooks and entries | route-by-route delivery tests and pending-state interception |
| 6 | Reproducible package patches | release manifest, repack helper, patched `local-agents` modules | SHA-256 before-and-after verification |

## Notes

- File names above are relative. All absolute local paths in the original integration are parameterized into configuration keys and environment variables before submission.
- The packaged version used for the hot patches is 0.3.2; the patches must be rebased onto the current upstream branch before merge.
- The inventory intentionally lists no credentials, account references, conversation data, machine-specific paths or internal project names.
- Source files are not published in this repository at the draft stage; only the draft and this inventory are included.
