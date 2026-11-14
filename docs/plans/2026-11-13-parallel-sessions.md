# Two sessions of one Bot running at once

- Date: 2026-11-13
- Related: Issue #1501

## Why

Today a Bot has one chat window. When a long job runs there, the user cannot start a
second job on the same Bot; the next request waits for the first to finish. The issue
asks for two parallel sessions of one Bot.

## Two views are not two sessions (decision)

"Open the same part in two windows" would share one DSH Session, and DSH runs one turn
at a time in a Session: a second send from either view is queued or steered into the
running turn. It looks like two windows but still works one job at a time, so it is not
what the issue asks for. The parallel behavior needs a second Session (a second part of
the Bot's own chat) with its own context. This note records that so a later change does
not quietly fall back to the two-view shape.

## Decided behavior

- A Bot's own chat is one or more **threads**. The current thread is `sessionId` with
  its earlier parts in `segments`; a thread opened while the Bot is busy stays live in
  `openParts`, with its own earlier parts.
- **New session while the Bot works**: the new part starts at once in the foreground
  and the part it replaces keeps running in the background. That background part is
  not archived and its turn is not stopped; the new part starts with a fresh context
  and no handoff note (the user asked for a new conversation).
- **New session while the Bot is idle** keeps the existing behavior: a manual switch
  with the deterministic handoff package, and the old part is archived.
- The details panel lists the sessions of every Bot (not only local-agent Bots): the
  current part, the live background parts, then the earlier parts. A background part
  shows a **Running** mark read from the host's live turns (`rt.live`), so the user
  sees that a second session is consuming model calls.
- Opening a background part makes it current; the two threads swap and both keep their
  own earlier parts. Nothing is archived or stopped by the swap. Opening a **running**
  part is read-only: the composer takes no input (Enter and the send button are
  blocked) until its turn ends, and a **Stop** action ends it. Two live sessions mean
  two model calls; the list says so.
- `chatOf(botId)` still returns the current part. Phone, IM, group chats and the Bot's
  identity are unchanged; they keep seeing the current part.

## Run mode

A Bot runs on one thing, so every thread of its own chat moves together: an idle part
moves at once, a running one moves at its next step, and one that cannot follow takes
no step until it has moved. A background part can never stay on the other run mode.

## Busy checks

`newPart` used to refuse while the Bot worked because its only path was a switch. It now
has two judged paths: idle → the existing switch; busy → a new part opens and the old
one stays live. `switchPart` still refuses to open an **archived** part while the
current turn runs (that switch archives what it replaces); opening a **live** part needs
no such wait because nothing is archived.

## Archiving

A switch to another part archives the part it replaces, as before. A background part is
archived only when its own thread moves on (context line, failed turn, run-mode change),
after its input has moved to the fresh part. Making another part current never archives
or stops it. Deleting a Bot releases every thread's sessions.

## Who is running

The host reads `rt.live` per session and exposes `running` for the current part and for
each background part. The client shows the mark from that state; it does not infer a
running turn from the transcript.

## A part is a thread everywhere, not only in the chat view

A second live Session must not become a side door. Everything that used to treat the
Bot's chat as one place follows the thread a part belongs to instead:

- **Permissions**: a preset change reaches every live part, and a change that fails
  halfway puts every part back on the preset the Bot had before it — not only the
  field. A stricter preset that misses the running background part would tell the user
  the Bot is strict while one part still runs wider.
- **Replies and requests**: a Bot writes to another Bot from the part it works in, so
  the answer comes back to that part's thread. The part is recorded with the request
  (the delivery source and the work record in `state.json`) and kept across a restart.
- **Resume and kept input**: work a restart cut off goes on in the part it ran in, and
  input a failed switch kept goes back to that part's thread. Only a part that is gone
  falls back to the Bot's current chat.
- **History**: a thread's earlier parts are the Bot's, and reading one reads that
  thread. `read_own_chat`, search and "load earlier" resolve a session to the thread it
  belongs to, including when the session is an earlier part that has already moved on.
- **Privacy**: a private Bot's background parts are closed to other Bots exactly like its
  chat.

## Out of scope

- Two windows side by side (the next step; this change is "parallel work", not "two
  visible windows"), and the two-view shape above.
- Group chats: membership and group sessions are untouched.
- The phone app: it keeps showing the current part.
- The Bot identity model: still one Bot, one identity, one memory.
