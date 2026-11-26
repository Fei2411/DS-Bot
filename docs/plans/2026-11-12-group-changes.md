# Group chat shows what each Bot changed, and opens the change review

A Bot's turn in a group ends with a line of text; the files it changed in its folder were
invisible there. This adds one row under that Bot's message: how many files it changed, the
added and removed line counts, and the first file names. Clicking the row opens DSH's own
changes-review tab for that turn — the same review the Bot's Session shows — instead of a
second diff viewer.

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

The change line is one button. Its action, `openChanges` in `src/client/index.js`:

1. asks the Host whether the summary is still served — a disposed Session says
   `These changes are no longer available`;
2. opens the review through one isolated function, `openChangesReview`, which opens the
   turn's Session in the shell and then opens
   `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>` once that Session's
   right column is mounted.

DSH's review tab reads the changes of the Session the shell shows; the Session inside the
address names the content, but the tab's data requests use the viewed Session. A group's
own Session is not the member's, so the review cannot be shown while the group stays on
screen without a DSH-side change (it already did not, before this work: the tab is built
for the Session it belongs to). Keeping the jump in `openChangesReview` means a future
review that can stay in the group replaces one function.

## Verified

- Two Bots writing different files in one group: two separate lines, one file each, each
  opening its own turn's review (`writer-notes.md`, `coder/app.js`).
- On the dev build the same conversation shows the replies with no change line.
- A turn that changed nothing, an absent service, an expired summary and a window without
  the right column each have their own test or message.
- Host unit tests (`test/changes.test.js`), client tests (`test/changes-card.test.js`), a
  group-round integration test (`test/rounds.test.js`), the full suite, the client build
  check, lint and the mock smoke run.

## Not in this change

- No task board or approval surface (that is #1441); no live streaming of edits.
- The dev mock model gained the same generic `调用 <tool> <json>` trigger for group
  members that it already had in a Bot's own chat, so a member's turn can be driven to a
  real tool call in a bench.
