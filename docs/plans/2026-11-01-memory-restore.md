---
date: 2026-11-01
issue: 464
---

# Restore a memory change from journal.jsonl

## What and why

`journal.jsonl` (and a private Bot's own log) already keeps every memory change with
the line before and after, but nothing reads it for undo: a wrong remember, replace,
or forget is permanent unless the files are edited by hand. This adds a narrow,
API-only restore — `memory-restore` on the `api/bot` channel — that applies the
inverse of one journal row. A panel History view can come later; this is the part
that makes the log actionable.

## Shape

- Request: `{ line, botId? }`. `line` is the 1-based line of the change log;
  `botId` picks a private Bot's own log (`bots/<id>/journal.jsonl`), everything
  else is in the shared log — the same routing `journalFor` uses for writes.
- One row is undone with its inverse op, and only while what it reads still reads
  as the row left it:
  - `add` → the recorded `after` line is taken back out, verbatim. A topic left
    with only its title is removed, and its `## Index` link with it — the same
    cleanup a forget does.
  - `remove` → the `before` line is put back where a new entry would go (the
    original position is not in the row). A topic the remove took away is made
    again with its link; a line already back is not duplicated.
  - `replace` → the line that still reads `after` is put back to `before`.
- Drift is a `NO_MATCH` failure, not a silent delete: the entry changed since, it
  is already back, or the line is there more than once.
- Restored content goes through `checkSize` like any other change.
- `archive` rows move whole folders and are not undone this way; any other row
  that is not a well-formed add/remove/replace is refused.
- A restore is itself a change: it is queued on the writer's line, published
  through `publish` like the rest — pending record first, files, then its own
  journal row. The row is the inverse op carrying `restored: <id>` of the row it
  undid, so a restore can itself be restored.
- Writes the user may do are what may be restored: `writable(scope, user)` — the
  deleted-Bot, deleted-group, and read-only guards all apply.

## Deliberately out of scope

- No version tree, no git, no multi-step undo. One row, one inverse.
- No UI. The endpoint is for the host channel now; a History view in the memory
  panel is the follow-up that consumes it.
- `archive` is a different, folder-level path and stays irreversible here.
