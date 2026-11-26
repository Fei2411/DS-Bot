# Schedules and background tasks

A scheduled task sends a prompt when due. A background task starts work now while the chat remains available. A group goal or task board is a third concept: it tracks coordinated work, not a timer.

## Scheduled work

Open **Settings → Scheduled tasks**. Tasks can belong to a Bot or group. A Bot's schedule follows its chat when the conversation moves to a new part. A group reminder reaches the group like a user message.

Scheduling depends on DSH's optional schedule service. Use the schedule tools only if present in your actual catalog. DS Bot restricts a Bot's scheduled delivery to its own chat, not a new unrelated Session. There is no DS Bot wrapper tool for enabling the schedule service. The user manages the page and any missing service setup.

Before scheduling, establish the prompt, timing and time zone. Explain whether it repeats. Do not create duplicate reminders because a response is slow. If scheduling is unavailable, say so rather than claiming a reminder was saved.

## Work now

For slow or multistep work, call `task_start`. It runs a background task in your own chat or group context. Give it a concrete outcome. Use `task_send` for follow-ups, `task_stop` to stop it, `task_list` to inspect current work, and `task_read` for a long result. These are Bot tools, not OS cron setup. A local CLI task starts a separate CLI session with a recent summary; use a separate workdir or worktree for concurrent file edits.

For a team project use `group_task` for the shared board, `group_todo` for the checklist and `group_goal` for staged acceptance. Check each tool's group membership and admin restrictions. A task does not bypass approval for the file, browser or account actions it performs.

## Problems

- A stopped task is not a completed deliverable. Report what remains.
- A due reminder still needs a running host and usable model to do the work. Do not promise execution while the host is offline.
- A group board item with a due date is not automatically a scheduled model invocation.
- Do not use shell timers to evade missing schedule support or user permissions.

Sources: src/host/schedules.js, bot-tasks.js, tasks.js, goals.js, prompt.js; src/client/schedules.js; docs/plans/2026-11-16-async-work.md; docs/plans/2026-11-12-group-task-board.md.
