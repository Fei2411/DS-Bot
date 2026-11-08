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
  DSH LLM adapter that DS Bot registers. Routes: `local-devin-cli`,
  `local-claude-code`, `local-codex-cli`, `local-opencode`, `local-cursor-cli`,
  `local-gemini-cli`, `local-grok-cli`, `local-cline`, `local-qwen-code`,
  `local-goose`, and `local-acp-<id>` for custom agents the user adds. A route
  appears only while its CLI is found; a refresh re-scans.
- The `local-` prefix keeps these routes apart from providers that DSH or other
  plugins register. Without it, a CLI named like such a provider (`opencode` is
  also DSH's OpenCode provider) made both register the same name, and the LLM
  service failed to load. Refs saved under the unprefixed names move to the
  prefixed ones when the team loads. An old `opencode/...` ref moves only for a
  Bot that ran on the local CLI or on its "CLI default"; otherwise it stays on
  DSH's OpenCode provider.
- A route's models are what its CLI reports, plus a "CLI default" entry.
- Every DS Bot Session maps to one CLI session. A Bot's own chat and each of
  its group sessions are separate CLI sessions, so no content crosses between
  them. Switching to an earlier part resumes its mapped CLI session; a part
  that belongs to another run mode moves on first (see Run mode).
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
- Starting a new session or changing the work folder starts a fresh part with
  a deterministic handoff: the last messages word for word, a list of earlier
  message anchors, and a line to use `read_own_chat` for details — no model
  call. A run-mode change starts fresh parts the same way, in the Bot's own chat
  and every group it is in together (see Run mode), because a CLI session cannot
  move between modes.
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

- Running an agent that has no ACP or equivalent stdio protocol, or wiring the
  tool bridge over stdio when an agent lacks MCP-over-HTTP support.
- Provider API keys for these routes: local agents use their own sign-in.
- Editing the CLI's own configuration files.

## Known limits

- An agent CLI that does not advertise MCP-over-HTTP cannot get the team tools;
  its text, approvals, and sessions still work.
- Cursor CLI saves the last model selected over ACP as its own global default
  (`~/.cursor`), so picking a specific model for one Cursor Bot also changes
  what other Cursor Bots on "CLI default" and Cursor in the terminal use.
- A custom agent whose ACP dialect differs from what these drivers understand
  needs its own driver before its tools work.
- The sign-in state comes from each CLI's own status command or credential
  file. A CLI that has neither, or whose check does not answer in time, shows
  unknown; unknown does not stop the user from picking it.
