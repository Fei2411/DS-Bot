# Bug report — intermittent team-state write failure on Windows

## Observed

A host-side atomic write of the team state file intermittently fails with
`EPERM: operation not permitted, rename <tmp> -> state.json`.
The failure does not prevent UI side effects: a question card was shown and
answered normally, yet the tool call was reported as failed because the
state write is treated as part of the same operation.

## Evidence

- Log: 345 EPERM lines; the first failures were preceded by
  "the Bot team file changed under this host's lock" in the lock checker.
- The state file was adopted from an external writer, and the host's own
  state was kept as a `.replaced-*` snapshot (several such snapshots exist).
- The temporary file name is fixed per host pid. After a failed rename the
  temporary file remained until a later successful write.
- ACL grants full control to the host and the user; the file is not
  read-only. This is not an attribute or permission issue.
- The state file is valid JSON and was updated successfully at times during
  the incident, so the failure is intermittent rather than a permanent lock.

## Suggested fix

1. Retry the rename with backoff on EPERM on Windows; a transient handle
   holder is common on this platform.
2. Decouple UI side effects from state persistence: a state-write failure
   must not mark an otherwise successful tool call as failed.
3. Make the lock checker recover cleanly after "changed while no host held
   the team", instead of leaving dual writers.
4. Use a unique temporary name per write and remove it on failure.
5. Clean up pending question entries after their answers are consumed.

## Disclosure note

No credentials, account identifiers, machine-specific paths, conversation
data or internal project names are included in this report.
