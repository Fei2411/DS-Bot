# Group task board: split by what the row asks of the user

Date: 2026-11-18 · Issue: #1610 (first half) · Related: #1663, #1763

## Why

The group task board (#1441, PR #1484) landed as a flat list. A task whose member
stopped sits between tasks that are running, and the state is carried by an 11px
coloured chip — `--bt-green` measures 1.94:1 on its own background, `--bt-accent`
3.83:1 and `--bt-danger` 4.19:1, so none of the three clears 4.5:1.

## What changes

1. **Three sections, fixed order**: `In progress` (`active`), `Needs you`
   (`review`, `blocked`), `History` (`done`, `cancelled`). Each has a count; the
   first two say so when empty; history shows the latest five rows and a
   `Show all (N)` line. This is presentation only — `room.tasks` is unchanged.
2. **A row carries its state in words**: a leading 18px icon plus one 12px line
   (`Chief · In progress`, `Chief · Blocked · Stopped by the user`,
   `Chief · Done · <time>`). The coloured chip is gone, so nothing depends on a
   small coloured glyph to be readable.
3. **A stopped row offers `Continue`**: it posts the user's message that calls the
   task's owner through the existing `task-note` path, so the member picks the work
   up where it runs. The row keeps its real state until the member updates it — it is
   not moved to `In progress` optimistically, because nothing may be running yet, and
   that is exactly what #1663 was about.
4. **New token `--bt-green-ink`**: `#0a7c47` in the light theme (5.13:1 on the panel,
   5.27:1 on a card) and `#4cd08a` in the dark theme (9.38:1 / 8.4:1). The icon needs
   3:1 as a graphic and the old `--bt-green` was 2.19:1 on white even as an icon.

## Not in this change

- User-created tasks, drag and drop, ticking a card off (#1610's second half): that
  needs a write side and its own design.
- Reordering by priority, due dates, deadlines.
- Any change to the `group_task` tool or its state machine.

## Layout notes

- Row: 12px padding, minimum height 56, icon 20 slot · text · 24 tail; the text block
  holds title 14/400 and one 12/400 line, plus the result or reason when closed.
- At 640 the title may wrap to two lines; at 480 the `Continue` button moves under the
  text, right-aligned, and never takes a row of its own centre.
- The turning icon stops under `prefers-reduced-motion: reduce`.
