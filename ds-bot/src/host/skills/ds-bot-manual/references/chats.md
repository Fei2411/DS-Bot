# Chats, groups, goals and parts

Each Bot has its own conversation. In a group it speaks from a separate conversation. A group has members, an optional admin, shared memory and an optional shared working folder. Group work can use more model calls than one Bot.

## UI and tools

Use **Settings → Group chats** to inspect and change groups. In a chat's **+** menu, **Reference a chat** adds another chat as context. **Set a goal** starts a staged group goal. Type /side for a side question without interrupting the main work.

- `message_bot` delegates to another Bot. Use it only for work or useful facts, not acknowledgements. Replies arrive later; do not poll. In a group it reaches only that group's members.
- `create_group` is Main Bot only. It joins the creator as admin unless another admin is named.
- `update_group` changes name, notice, members, admin, reply mode or work_dir. A Main Bot can manage any group; the group's admin can manage its group, but only a Main Bot can change its working folder or sidebar section.
- `post_to_group` posts from outside a group. A Main Bot's or the admin's post starts a discussion. Another member's post calls the members it names with @Name. A Main Bot can post to any group.
- `delete_group` archives a group and is Main Bot only. Use it only when the user asks.
- `group_goal` manages staged goals. The admin normally runs it. Load goal-grill before starting: align objective, acceptance, constraints, stages and assigned tasks with the user.
- `group_task` manages the group's shared task board. `group_todo` manages its checklist. These are not scheduled reminders.

By default the admin answers ordinary group messages. @Name chooses who answers. In everyone mode, members answer in order with the admin first. Bots can hand work to members with @Name. Do not send the same assignment through several routes.

## Context and handoffs

Long conversations either condense older content into checkpoints or move to a fresh part with a handoff note. Earlier records remain readable. Use `read_own_chat` for exact wording or earlier part notes, and `read_group_chat` for group history. Search first, then use a returned anchor to read surrounding messages. Do not reconstruct missing details from memory.

## Rights and problems

Group folder changes can require user approval. Group membership does not grant private Bot access. If a Bot does not answer, check mentions, membership, admin and reply mode with `list_bots`. If a goal is blocked, report the failed acceptance check rather than advancing stages. Moving to a new part is not deletion of old history.

Sources: README.md (Group chats); src/host/prompt.js, tools.js, goals.js, tasks.js; docs/plans/2026-11-01-group-goal.md; docs/plans/2026-11-12-group-task-board.md.
