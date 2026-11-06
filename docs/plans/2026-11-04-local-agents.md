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
  DSH LLM adapter that DS Bot registers. Routes: `devin-cli`, `claude-code`,
  `codex-cli`, `opencode`, `cursor-cli`, `gemini-cli`, `grok-cli`, `cline`,
  `qwen-code`, `goose`, and `acp-<id>` for custom agents the user adds. A route
  appears only while its CLI is found; a refresh re-scans.
- A route's models are what its CLI reports, plus a "CLI default" entry. The
  Bot's model picker shows these routes like any provider, and a local-agent
  route can be picked when a Bot is created.
- Every DS Bot Session maps to one CLI session. A Bot's own chat and each of
  its group sessions are separate CLI sessions, so no content crosses between
  them. Switching to an earlier part resumes its mapped CLI session.
- The CLI gets only new input since the last handed message: the user, other
  Bots, and tool results for calls it made. On a new or lost CLI session, the
  DS Bot system prompt plus a bounded recent window of the history is sent as
  the first prompt. The system prompt is sent as appended instructions — never
  over the CLI's own — and is re-sent, marked as an update, only when it
  changes.
- The DS Bot team tools the Bot's role allows are offered to the CLI over a
  loopback MCP server (one random port and bearer token per CLI session; a bad
  token is refused). When the CLI calls one, the call leaves the stream as a
  normal assistant tool call so DSH runs it — logged, with approvals and the
  usual presentation — and its result answers the suspended CLI call on the
  next step. Calls that arrive while one runs are queued and go out on the next
  step.
- The CLI's own work — its thoughts, plans, and tool calls — shows as the
  Bot's thinking rows, one compact line per action. Its final answer is the
  message text. Usage it reports is recorded.
- No DS Bot or engine compaction runs on an abot session: the CLI owns
  compaction inside its own session, and the full history stays in the DSH
  Session for `read_own_chat`. Steward calls are skipped for local-agent
  routes.
- A permission prompt from the CLI becomes an `approve_agent_action` tool call
  that DS Bot shows as a normal approval card. Allow picks the agent's
  allow-once option; anything else denies it. It fails closed: only an explicit
  allow option counts. The Bot's permission preset maps to the closest mode the
  agent advertises.
- Starting a new session, changing the work folder, or changing the Bot's
  engine starts a fresh part with a deterministic handoff: the last messages
  word for word, a list of earlier message anchors, and a line to use
  `read_own_chat` for details — no model call. An engine change must start a
  fresh part because a CLI session cannot move between engines.
- The after-turn memory review uses the team default model when one is set, and
  is skipped when there is none. Abots get memory in the system prompt and the
  remember, forget, and recall tools like any Bot.
- Abots are full peers: a Main Bot, a group admin, or a member.
- Steering while a CLI turn runs is passed to the CLI when it supports it, else
  it goes out as the next prompt in the same step.
- An abort cancels the CLI turn and any suspended calls.
- Settings → Local agents lists the detected agents (name, path, version, and
  sign-in state where it is cheap to check), a Refresh action, a Sign in action
  per agent, and the custom agents with add, edit, and remove. A custom agent
  has a name, a command, and arguments; the command must be a bare name, an
  absolute path, or `~/…`, and no shell is used.
- Each engine has an original badge shown small beside the Bot's name in the
  sidebar, the chat header, and its details. A new abot's avatar defaults to
  its badge; the user can still pick a character.

## Out of scope

- Running an agent that has no ACP or equivalent stdio protocol, or wiring the
  tool bridge over stdio when an agent lacks MCP-over-HTTP support.
- Provider API keys for these routes: local agents use their own sign-in.
- Editing the CLI's own configuration files.

## Known limits

- An agent CLI that does not advertise MCP-over-HTTP cannot get the team tools;
  its text, approvals, and sessions still work.
- A custom agent whose ACP dialect differs from what these drivers understand
  needs its own driver before its tools work.
