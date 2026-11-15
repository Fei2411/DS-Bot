# Group chat shows what each Bot changed, and opens the change review

A Bot's turn in a group ends with a line of text; the files it changed in its folder were
invisible there. This adds one row under that Bot's message: how many files it changed, the
added and removed line counts, and the first file names. Clicking the row opens that turn's recorded diff inside the group conversation.

## What the group shows

- One change line per Bot turn, drawn under that Bot's last message of the turn (or under
  its "finished its work" line when the turn posted no text). Each member's line comes from
  its own turn, so two Bots working at once never share a line.
- The line names up to three files and counts the rest (`and 2 more`), with the turn's total
  added and removed lines.
- A turn that changed nothing draws no line. A session without DSH's `workspace-changes`
  service draws no line either; the chat does not grow an empty row.

## Where the numbers come from

DSH's `@deepseek-ai/dsh-workspace-changes` records one summary per top-level turn and
announces it with a workspace-changes Session event carrying the turn number. The Host
keeps the summary (files, line counts, and each file's comparison) until the Session is
disposed.

`src/host/changes.js`:

- remembers the latest announced `(seq, turn)` per Session from the live `session/event`
  stream, and falls back to the tail of the Session log for a Session whose event came
  before this process listened;
- asks `ctx.workspaceChanges.summary(sessionId, seq)` for the summary, and maps it to the
  small record a group row carries: `sessionId`, `seq`, `turn`, `total`, `added`,
  `deleted`, and up to eight `{ path, added, deleted }` entries (display paths);
- answers `changesAvailable(sessionId, seq)` for the click, so a summary that is gone
  (Session archived or replaced by a part switch) reports itself instead of opening an
  empty tab.

The record rides the same path a member's line takes into the group's book: the final post
of a round (`postInRound`), a post that joins a running round, the queue a relay drains
(`runRoundFrom`), and the late reply a turn posts after the round moved on
(`lateRoomReply`). The row mapper (`rowOf`) adds it to the row, so the live round, the
settled round and earlier pages all show it. Nothing outside the group's own member
Sessions is read: the Session named on a row is the one whose turn posted it, and only for
a member of that room.

## The click

The change line opens a DS Bot review sheet above the group conversation. Closing it
returns to the same group and scroll position. The Host uses the documented
`workspaceChanges.summary(sessionId, seq)` and `diff(sessionId, seq, index, signal)`
methods for the recorded turn; it never accepts a caller-provided file path.

The sheet lists all files in the summary. Text files use the existing Markdown code
renderer to show the service's unified hunks without recomputing the diff. Binary and
oversized files have an explicit preview state. A disposed summary reports that the
changes are no longer available, and a failed request can be retried.

A new turn invalidates the previous turn's announcement for new group rows. When the
current turn changed nothing it cannot inherit the earlier turn's files, including after
a reload. A completed tool-only turn still posts its own change line.

## Not in this change

- No task board or approval surface (that is #1441); no live streaming of edits.
- The dev mock model gained the same generic `调用 <tool> <json>` trigger for group
  members that it already had in a Bot's own chat, so a member's turn can be driven to a
  real tool call in a bench.
