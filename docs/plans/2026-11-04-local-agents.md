# Local agent CLIs as Bots

- Date: 2026-11-04
- Related: Issue #916

## Why

Users already have coding-agent CLIs installed, signed in, and paid for. A Bot
whose model route is served by a local CLI uses that sign-in, subscription, and
model — no API key, no second plan — while staying a normal Bot for the user:
private and group chats, handoffs, approvals, memory, tools, search, sessions,
and model changes all work the same way.

## Decided behavior

- An abot is a normal Bot whose model route is a local-agent route served by a
  DSH LLM adapter that DS Bot registers. Built-in routes: `local-devin-cli`,
  `local-claude-code`, `local-codex-cli`, `local-cursor-cli`,
  `local-copilot-cli`, `local-gemini-cli`, `local-antigravity`,
  `local-opencode`, `local-cline`, `local-kilo`, `local-goose`,
  `local-grok-cli`, `local-kimi-cli`, `local-qwen-code`, `local-codebuddy`,
  `local-qoder`, `local-minimax-code`, `local-glm-cli`, `local-kiro-cli`,
  `local-factory-droid`, `local-auggie`, `local-mistral-vibe`, `local-junie`,
  `local-iflow`, plus `local-acp-<id>` for custom agents the user adds. A route
  appears only while its CLI is found; a refresh re-scans.
- The `local-` prefix keeps these routes apart from providers that DSH or other
  plugins register. Without it, a CLI named like such a provider (`opencode` is
  also DSH's OpenCode provider) made both register the same name, and the LLM
  service failed to load. Refs saved under the unprefixed names move to the
  prefixed ones when the team loads. An old `opencode/...` ref moves only for a
  Bot that ran on the local CLI or on its "CLI default"; otherwise it stays on
  DSH's OpenCode provider. A CLI added after the prefix (such as `qoder`,
  `antigravity` or `mistral-vibe`) was never saved unprefixed, so its name is
  always a provider's. The move runs once per team: a ref saved
  after it under an unprefixed CLI name belongs to a provider of that name and
  stays.
- A route's models are what its CLI reports, plus a "CLI default" entry.
- Every DS Bot Session maps to one CLI session. A Bot's own chat and each of
  its group sessions are separate CLI sessions, so no content crosses between
  them. Like any other Bot, an abot has one continuous conversation — no
  session list or manual session switching.
- The CLI gets only new input since the last handed message: the user, other
  Bots, and tool results for calls it made. Context-only messages (clock ticks,
  memory snapshots/updates, silent notices) are classified by one shared module
  (`context-messages.js`) and staged without waking an idle CLI. On a fresh CLI
  session, team instructions are delivered once over the engine's native channel
  (developer config for Codex, `--append-system-prompt-file` / `--append-system-prompt`
  for Claude Code, prompt header for ACP — never duplicated in the replay header
  for Codex/Claude, and with DSH-only built-in tool prompt sections stripped).
  If a saved CLI session can no longer be resumed, DS Bot escalates it to a
  formal `runtime-lost` part switch with the unified deterministic handoff
  package (`context-pack.js`) instead of silently replaying inside the same part.
- The DS Bot team tools the Bot's role allows are offered to the CLI over a
  loopback MCP server (one random port and bearer token per CLI session; a bad
  token is refused). The MCP server advertises `tools.listChanged: true`,
  streams `notifications/tools/list_changed` over authenticated `GET /mcp` SSE
  (including through `mcp-stdio.js`) when the Bot's active tool set changes, and
  batches concurrent `tools/call` requests into one DSH step. When the CLI calls
  a team tool, the call leaves the stream as a normal assistant tool call so DSH
  runs it — logged, with approvals and the usual presentation — and its result
  answers the suspended CLI call on the next step.
- The CLI's own work — its thoughts, plans, and tool calls — shows as the
  Bot's thinking rows, one compact line per action. Its final answer is the
  message text. Usage it reports is recorded.
- An abot's long conversation is handled like any Bot's (see Context below):
  the user keeps talking in one chat, and DS Bot moves it to a fresh part at a
  stopping point.
- A permission prompt from the CLI becomes an `approve_agent_action` tool call
  that DS Bot shows as a normal approval card. Allow picks the agent's
  allow-once option; anything else denies it. It fails closed: only an explicit
  allow option counts. The Bot's permission preset maps to the closest mode the
  agent advertises.
- Changing the work folder starts a fresh part automatically as
  for any Bot: the old CLI session writes the handoff note (see Context). A
  run-mode change starts fresh parts with the deterministic handoff — the last
  messages word for word, a list of earlier message anchors, and a line to use
  `read_own_chat` for details — in the Bot's own chat and every group it is in
  together (see Run mode), because a CLI session cannot move between modes.
- The after-turn memory review and the memory panel's model calls run on the
  Bot's own CLI and model, in a one-off read-only session, as the steward does. Abots get memory in the system prompt and the
  bot_remember, bot_forget, and bot_recall tools like any Bot.
- Abots are full peers: a Main Bot, a group admin, or a member.
- Steering while a CLI turn runs is passed to the CLI when it supports it, else
  it goes out as the next prompt in the same step.
- An abort cancels the CLI turn and any suspended calls.
- Settings → Local agents lists the detected agents (name, path, version, and
  sign-in state where it is cheap to check), a Refresh action, a Sign in action
  per agent, and the custom agents with add, edit, and remove. A custom agent
  has a name, a command, and arguments; the command must be a bare name, an
  absolute path, or `~/…`, and no shell is used.
- Each built-in engine uses its own product logo, with a glyph fallback, shown
  small beside the Bot's name in the sidebar, the chat header, and its details.
  A new abot's avatar defaults to its badge; the user can still pick a character.

## Context (decided 2026-11-14, #1593)

The CLI holds the working context of its session; the DSH Session keeps the
whole record for `read_own_chat` and is never condensed. DS Bot applies the
rules of [context and memory](2026-10-09-context-and-memory.md) to the CLI
session:

- Size and window are resolved through `ContextRuntime` from what the CLI
  reports (`workingTokens` vs DSH's persistent `logTokens`): ACP `usage_update`
  (`used`, `size`), Codex `thread/tokenUsage/updated` (`last.totalTokens`,
  `modelContextWindow`), Claude Code's per-response usage and
  `modelUsage[].contextWindow`. The lines follow that window with no hardcoded
  380k cap (only an explicit `checkTokens` config caps it). A CLI that reports
  nothing is not checked, and its context stays the CLI's own business.
- At the end of a turn past the check line, the context steward decides once:
  condense in place, or move to a fresh part. The CLI also condenses on its own
  near its window, which may lie below the check line; each compaction bumps the
  part's persisted `epoch` so fresh memory snapshots and group boilerplate are
  re-injected cleanly, and counts toward the part's persisted compaction count.
- Inside a running turn DS Bot cannot step in between the CLI's model calls:
  the CLI's own compaction covers it, and a CLI that reports its context is past
  its window fails the turn as an overflow (classified after rate-limit/auth
  checks so TPM limits never trigger a part switch), which moves the part on.
  When repeated overflows cannot make room automatically, the chat offers a
  visible recovery action to start a clean part.
- The steward runs on what the conversation runs on, as for any Bot: the Bot's
  own CLI and model answer it, in a one-off session with no team tools and
  read-only access.
- Condense in place is the CLI's own compaction: `/compact` for Claude Code and
  for an ACP agent that lists a `compact` command, `thread/compact/start` for
  Codex. An agent with no such command condenses only on its own. A
  compaction that leaves the part past the check line moves it on; a CLI that
  says how full it is only with its next answer is judged then. An ACP agent
  gets the team instructions again after a compaction, since it read them as a
  prompt.
- The handoff note is written by the old CLI session while the Bot is idle, as
  one more prompt the conversation never sees: it has the whole working context
  and its own cache. Note failures distinguish requests that never reached the
  CLI (busy, suspended bridge, process exit, resume lost — stays in the part
  with 1/5/15m backoff) from requests that reached the CLI and failed (moves on
  with the deterministic package and the last note it wrote).
- The fresh part opens a new CLI session with the handoff package, like any
  part. Stale `state.localAgents.sessions` records are removed on part archival,
  Bot deletion, group leave/delete, and periodic pruning.
- Running foreground turns on a local CLI can move to the background: the old
  Session keeps its running CLI session in `bot.tasks[]` while the new
  foreground opens a fresh CLI session seeded with the fallback context summary.
  Background `task_start` uses native CLI session `fork` (Codex `thread/fork`,
  Claude `--resume --fork-session`) when detected as supported by the installed
  CLI version, falling back cleanly to a fresh session + summary otherwise.

## Run mode

How a Bot runs is a property of the Bot: on DS Bot models, or on one local
agent CLI. The two do not share tools, context, permissions, or memory
handling, so they do not mix in one model list.

- The run mode is derived from the Bot's model ref: a ref whose provider is a
  local-agent route runs on that CLI; any other ref runs on DS Bot models. No
  new field is stored, and routing stays on the existing LLM adapter.
- The Create Bot form starts with a choice at its top: "DS Bot model" or
  "Local agent". Local agent lists the CLIs found on this machine as cards with logo, name, and
  sign-in state (signed in, not signed in, unknown).
- After creation, only the user changes the run mode, only in the Bot's
  settings, and only after a confirmation. No tool changes it; `update_bot`
  refuses.
- The confirmation says what the change does to this Bot: which of its
  conversations start a new part, and that earlier messages, memory, and
  instructions stay. Moving onto a local agent it also says, when they apply,
  that the Bot's shared MCP servers and skills do not reach the CLI, that a
  CLI that is not signed in fails its turns, and that a private Bot's privacy
  rules do not cover the CLI's own tools.
- A private Bot may move onto a local agent: the confirmation warns, it does
  not block (decided 2026-11-07).
- On confirmation the Bot's own chat and every group it is in start a fresh
  part together, with the deterministic handoff, and the next turn runs on the
  new mode. A chat in the middle of a turn moves before its next step. A part
  with no request yet is already fresh.
- Another model of the same CLI, or another DS Bot model, is an ordinary model
  change: no confirmation, no new part.
- Model menus list only the Bot's own kind: a Bot on DS Bot models never sees a
  local agent, and a local agent Bot sees only its CLI's models. The team
  default model and the first-model card list DS Bot models only.
- Listing the team state, the models, or the local agents starts no CLI. A
  local agent Bot's own model menu, or picking a CLI's card when creating a
  Bot, asks that one CLI for its models once; later looks read that answer
  until the user refreshes the local agents.
- A fallback never crosses modes. A model no longer served falls back within
  its mode. A local agent Bot whose CLI is gone stays on that CLI and says so.

## Existing local agent Bots (decided 2026-11-07)

- No migration step and no new choice. The mode is derived from the ref, so an
  existing local agent Bot follows these rules as soon as it upgrades. The user
  already made this choice, there is nothing to convert, and a downgrade has
  nothing to undo.
- Current parts stay current and keep their CLI sessions. A forced fresh part
  would discard CLI context for no gain.
- One case heals itself. Earlier rules moved only the Bot's own chat on an
  engine change, so a group part may still belong to the other mode. Before its
  next step there, that part moves on with the deterministic handoff. The same
  applies to an earlier part opened again.
- Earlier parts stay readable and searchable.
- A team default model that is a local-agent route counts as unset, so new Bots
  do not silently become local agent Bots.
- Not chosen: asking every such Bot to choose again repeats a choice already
  made; a fresh part for all of them loses CLI context.

## Out of scope

- Running an agent that has no ACP or equivalent stdio protocol.
- Provider API keys for these routes: local agents use their own sign-in.
- Editing the CLI's own configuration files.

## Known limits

- ACP agents receive team tools via Streamable HTTP MCP when advertised, or via
  DS Bot's stdio MCP bridge (`mcp-stdio.js`) when HTTP MCP is unsupported or
  rejected. Only an agent that rejects MCP servers altogether runs without team
  tools; its text, approvals, and sessions still work.
- Cursor CLI saves the last model selected over ACP as its own global default
  (`~/.cursor`), so picking a specific model for one Cursor Bot also changes
  what other Cursor Bots on "CLI default" and Cursor in the terminal use.
- A custom agent whose ACP dialect differs from what these drivers understand
  needs its own driver before its tools work.
- A CLI that reports no context usage (some ACP agents, custom agents) keeps
  its context to itself: DS Bot moves it on only for an overflow, a new
  session, a work-folder change, or a run-mode change.
- The sign-in state comes from each CLI's own status command or credential
  file. A CLI that has neither, or whose check does not answer in time, shows
  unknown; unknown does not stop the user from picking it.

## Changes

- 2026-11-25: Unified local-agent context management under `ContextRuntime` and `context-pack.js`: formal `runtime-lost` part switches, reached-vs-unreached handoff note backoff, `epoch` post-compaction memory/instruction redelivery, instruction dedup, MCP `list_changed` SSE + parallel call batching, local CLI foreground-to-background move, capability-detected Codex/Claude session `fork`, and `state.localAgents.sessions` lifecycle cleanup.
- 2026-11-22: Correct the engine badge description to product logos with fallback glyphs (#1009), corrected against the dev code.
