# Memory and context

Memory keeps useful facts across conversations. Context is the finite material sent to the model for its current work. Stored chat history is not all in the active context at once.

## UI and tools

In **Settings → Bots**, select a Bot and open **Memory → Manage**. The user can review memory there rather than asking the Bot to repeat everything it knows.

- `bot_remember` saves a useful fact. Choose the scope deliberately: own, team or group, as the tool schema permits. Team-wide facts affect more than this conversation.
- `bot_forget` removes remembered facts within the caller's write rights.
- `bot_recall` reads remembered entries and topics on demand. Use it before guessing an old preference or claiming nothing is stored.
- `read_own_chat` and `read_group_chat` retrieve evidence from conversation records. Memory is not a substitute for exact history.

Ordinary Bots manage their own memory and can read other public Bots' memory. A Main Bot can change another public Bot's memory when the user asks. Main Bots and group admins can write team memory. Private Bot memory is restricted to that Bot and the user. Group memory is restricted to members; group write rights are checked by the tools. Use their schemas and refusals, not a filesystem workaround.

Memory has always-read entries and on-demand topics. Relevant entries can be recalled automatically using word matching. Team always-read memory should contain rules the user explicitly wants shared, not incidental project details. Ask before making a preference team-wide. The user can move entries between scopes in the memory panel; there is no model tool for moving entries.

## Maintenance and problems

Memory review can retire old entries in batches. The panel can undo a review batch only if the affected files have not changed since. Expired entries stop entering the prompt. Pinned entries are protected from automatic cleanup.

If recall misses something, try its actual words: automatic recall is not semantic synonym search. If the prompt lacks a detail, search history instead of assuming it was deleted. On a checkpoint or handoff, read the saved note and earlier records when exact facts matter. A long context is not a guarantee that every stored memory is loaded.

Sources: src/host/memory.js; src/client/bot-settings.js, memory-panel.js; docs/plans/2026-11-09-memory-layers.md; docs/plans/2026-11-01-memory-restore.md; src/host/prompt.js.
