// Fixed values shared by the host modules: colors, OCR settings, the client route, and
// the limits on messages, group chats, and chat reads.

// Classic avatar inks, offered as Bot colors.
export const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
// Deeper inks, also offered as accent swatches; each is a valid Bot color too.
export const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
// Renamed color ids, so a Bot saved with an old one keeps its color (LEGACY: old id → new id).
export const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
// Renamed theme ids, so a saved choice keeps its look (LEGACY: old id → new id).
export const LEGACY_THEMES = { grok: 'mono', celadon: 'fei' }

export const OCR_PROMPT = [
  'Transcribe all text in this image exactly, in its original language, keeping line breaks and reading order; use Markdown tables for tables.',
  'Then add a line starting with "Image:" that describes in one to three sentences what is not text (photo, chart, diagram, screen layout).',
  'Reply with only that. If there is no text, reply with only the "Image:" line.',
].join(' ')
export const OCR_TIMEOUT_MS = 120_000
export const OCR_RETRY_MS = 120_000
export const OCR_CACHE_MAX = 500
export const MAX_AVATAR_IMAGE = 160_000
export const ROUTE = '/api/bot'
export const MAX_EXCHANGES = 600
// state.json is written whole on every save, so a long message between Bots or a long
// group line keeps only its start there. The rest stays where it already is (a message
// in the Session it was delivered to) or in a file of its own (a group line).
export const TEXT_KEPT = 2000
// Of one group line, a member reads this much: in its prompt, and with read_group_chat.
export const GROUP_LINE_READ = 20_000
// The Bot exchange dialog shows at most this much of one message.
export const TEXT_SHOW_MAX = 200_000
// A message a Bot sends past this goes as a DSH file, which the recipient reads with its
// file tools; the message keeps its first LONG_HEAD characters.
export const MESSAGE_INLINE_MAX = GROUP_LINE_READ
export const LONG_HEAD = 1000
// DSH's read tool shows this much of one line (dsh-tool-fs `readMaxLineLength`, default).
export const READ_LINE_MAX = 2000
export const ROOM_REPLY_TIMEOUT_MS = 240_000
// Lines a member writes less than this apart while it works reach its group together.
export const ROOM_STEP_GAP_MS = 30_000
export const SOURCE_KIND = 'bot'
// The fixed reply that opens a fresh conversation part; it is never shown or sent on.
export const HANDOFF_ACK = 'Noted. I have my handoff note and carry on from here.'
// A result that arrives after the user gave up waiting for it: it settled once
// already, so it closes nothing and opens nothing, and its text says why it is late.
export const LATE_ANSWER = '[Late answer: the user had already given up waiting for this work; its result was settled then.]\n\n'
// An answer from a question card, in the shape DSH's own late question replies use.
export const REPLY_KIND = 'user-question-reply'
// DSH's snapshot of a referenced conversation, logged right after the user's message
// that cites it.
export const REFERENCE_KIND = 'session-reference'
// `everyone`: every member answers a plain message in turn, admin first. `admin`: a
// plain message goes to the admin, who calls others with @mentions. New groups start
// in `admin` mode, because every extra speaker re-reads its whole context; a group
// without an admin still answers as `everyone`.
export const ROOM_MODES = ['everyone', 'admin']
export const ROOM_NAME_MAX = 60
export const ROOM_NOTICE_MAX = 2000
export const ROOM_MAX_MEMBERS = 12
// The shared to-do list of a group: one line per item, and a cap on the whole list so
// a group cannot grow it without bound.
export const ROOM_TODO_TEXT_MAX = 200
export const ROOM_TODO_MAX = 100
export const SECTION_NAME_MAX = 32
export const SECTION_COLORS = ['blue', 'orange', 'green', 'violet', 'rose']

// A team's one DSH Agent: a plain dsh entry in the sidebar, not a Bot. Its Sessions
// are ordinary root Sessions, so the team tools must not be offered to them.
export const AGENT_NAME = 'DSH Agent'
export const AGENT_SESSION_TITLE_MAX = 80
// Every tool this plugin defines for Bot Sessions; tools.js registers them in
// each Bot session's own scope. `read_browser` only exists in the Desktop
// profile, and `read_document` only while DeepSeek OCR is on, so the list
// served to one session can be shorter.
export const TEAM_TOOLS = [
  'list_bots', 'delegate_work', 'ask_back', 'answer_work', 'cancel_work', 'note_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_bot_models',
  'create_group', 'update_group', 'delete_group', 'group_todo', 'post_to_group', 'ask_user', 'show_view', 'prepare_ds_bot_issue',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'bot_remember', 'bot_forget', 'bot_recall', 'read_browser', 'read_document',
  'list_capabilities', 'save_capability', 'delete_capability',
  'attach_capability', 'detach_capability', 'use_pack', 'drop_pack', 'group_goal', 'group_task', 'list_connectors', 'request_connector',
  'task_start', 'task_send', 'task_stop', 'task_list', 'task_read',
]
// Team-meta, memory, and status-inspection tools do not count as external work progress
// when checking Bot-to-Bot or group ping-pong loops.
export const NON_WORK_TOOLS = new Set([
  'delegate_work', 'ask_back', 'answer_work', 'cancel_work', 'note_bot', 'message_bot', 'stop_bot',
  'list_bots', 'list_bot_models', 'post_to_group', 'group_relay',
  'bot_remember', 'bot_forget', 'bot_recall', 'remember', 'forget', 'recall',
  'read_own_chat', 'read_group_chat', 'task_list', 'task_read',
  'list_secrets', 'list_capabilities', 'list_connectors',
])
export const isWorkTool = name => typeof name === 'string' && name !== '' && !NON_WORK_TOOLS.has(name)

// Team-meta mutations that count as substantive work (clearing idle streaks and
// waking batch callers) but finish instantaneously so they skip the 15s grace timer.
// Slow team work tools such as read_browser, read_document, and task_start stay out
// of this set so they still yield to the 15s grace timer like any other work tool.
export const INSTANT_WORK_TOOLS = new Set([
  'create_bot', 'update_bot', 'create_group', 'update_group', 'delete_group',
  'group_todo', 'group_goal', 'group_task', 'ask_user', 'show_view',
  'prepare_ds_bot_issue', 'request_secret', 'request_connector',
  'save_capability', 'delete_capability', 'attach_capability', 'detach_capability',
  'use_pack', 'drop_pack', 'task_send', 'task_stop',
])

// Pure silent/pass/stage-direction text produced on a Bot-triggered own-chat turn when
// the Bot has nothing to tell the user (e.g. "[PASS]", "（静默。）", "（收工。）", "（完。）").
const SILENT_TURN_TEXT = /^\s*(?:[[【(（]\s*(?:pass|silent|silence|no\s*reply|nothing\s+to\s+report|done|noop|静默|收工|完|完毕|无回复|无需回复|略|跳过|待命)\s*[.。!！]*\s*[\]】)）]|pass\s*[.。!！]?)\s*$/i
export const isSilentTurnText = text => {
  const trimmed = String(text ?? '').trim()
  return trimmed === '' || SILENT_TURN_TEXT.test(trimmed)
}

// Tools that render visible user-facing UI cards, interactive views, handoffs, or files.
// A turn that invokes any of these must never be auto-hidden as a silent turn.
export const USER_UI_TOOLS = new Set([
  'show_view', 'ask_user', 'request_secret', 'request_connector',
  'mail_send', 'browser_handoff', 'computer_handoff', 'present_file',
])

// Short wrap-up / acknowledgement / standby texts used to detect ACK-of-ACK ping-pong
// immediately (on bounce #1) while allowing substantive multi-step pure-LLM work.
// Uses two flat, non-nested O(n) scans to guarantee zero catastrophic backtracking.
const ACK_CORE_TOKEN = /(?:收到|好的|好|明白|明白了|了解|了解了|知道了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|收工|待命|完毕了|完毕|完|静默|无待办|没有待办|不用再回|不用回|无需回复|已知悉|\b(?:okay|ok|got\s+it|roger|acknowledged|ack|noted|thank\s+you|thanks|done|all\s+set|standing\s+by|standby|no\s+action|no\s+reply|wrapped\s+up|good\s+to\s+go)\b)/gi
const ACK_FILLER_TOKEN = /(?:我也|我已|我|这边|这里|一切|全部|继续|没有|不用|无需|待办|嗯|行|已|先|就|都|[，,。.!！、；;：:~～\s]+)/gi
export const isAckLikeText = text => {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '' || trimmed.length > 140) return false
  if (isSilentTurnText(trimmed)) return true
  ACK_CORE_TOKEN.lastIndex = 0
  if (!ACK_CORE_TOKEN.test(trimmed)) return false
  ACK_CORE_TOKEN.lastIndex = 0
  const stripped = trimmed.replace(ACK_CORE_TOKEN, ' ').replace(ACK_FILLER_TOKEN, '')
  return stripped === ''
}

// Max ask_back clarification rounds on one delegated work before pausing for the user.
export const WORK_ASK_BACK_LIMIT = 2
// Idle/rework pair loop entries expire after this much inactivity between two Bots.
export const PAIR_LOOP_TTL_MS = 10 * 60_000
// Consecutive automatic admin wakes with no goal progress before the goal waits
// for the user instead of waking the admin again.
export const GOAL_IDLE_NUDGES = 2
// How long a Bot's own chat waits for a shell call before it goes on as a background
// job and the step moves on (settings can change it; 0 hands every call over).
export const BACKGROUND_WAIT_MS = 5_000
export const BACKGROUND_AFTER_MAX_SEC = 600
// Above this many parent-session events, task_start skips DSH session fork (which
// copies the whole event log) and opens a fresh lightweight Session seeded with a
// structured context summary and read_own_chat access to the parent part.
export const TASK_FORK_MAX_EVENTS = 600

// Tools that only operate on group chats: hidden from non-Main Bots in zero groups,
// and from Main Bots when the team has no groups yet (create_group stays available).
export const GROUP_ONLY_TOOLS = [
  'read_group_chat', 'post_to_group', 'group_todo', 'group_goal', 'group_task', 'update_group',
]

// Catalog feature-pack tools: hidden when a Bot has no catalog packs attached and no
// packs currently loaded in the session.
export const CATALOG_PACK_TOOLS = ['use_pack', 'drop_pack']

// Team tools unconditionally refused inside background task sessions.
export const TASK_HIDDEN_TEAM_TOOLS = [
  'browser_handoff',
  'task_start', 'task_send', 'task_stop', 'task_list', 'task_read',
  'ask_user', 'show_view', 'request_secret', 'prepare_ds_bot_issue',
]
// A member still at work this long after its first tool call lets the round go on; it
// posts its reply when the work is done.
export const ROOM_WORK_GRACE_MS = 15_000
// Consecutive Bot-to-Bot relays with no work tool and only repetitive or ack text
// before the round parks the remaining calls and asks the user before continuing.
export const ROOM_IDLE_RELAY_LIMIT = 2
// Consecutive Bot-to-Bot relays with no work tool at all before pausing even when
// each turn rephrases its chatter.
export const ROOM_ZERO_WORK_RELAY_LIMIT = 4
// Runaway single-Bot & multi-Bot pause guards: pause visibly so the user can see and
// click Continue (or steer), never silently drop work.
export const CONSECUTIVE_TOOL_ERROR_PAUSE = 8
export const REPEAT_TOOL_CALL_PAUSE = 12
export const REPEAT_TOOL_CYCLE_PAUSE = 6
export const AUTO_SWITCH_RESUME_LIMIT = 3
export const LOCAL_AGENT_SESSION_LOST_LIMIT = 2
export const GOAL_STAGE_REWORK_LIMIT = 4
export const ALWAYS_RETRY_MAX = 10
export const ALWAYS_AUX_RETRY_MAX = 6

export const OWN_CHAT_LINE_MAX = 400
// The message an anchor points at is shown whole (up to this), so a long draft takes
// one read instead of many searches for its pieces.
export const ANCHOR_LINE_MAX = 8000
export const OWN_CHAT_BRIEF = 10
export const OWN_CHAT_READ = 12
export const OWN_CHAT_SEARCH = 20
export const HISTORY_PAGE = 200
export const HISTORY_PAGES_MAX = 50
export const HISTORY_TIMEOUT_MS = 20_000
// How far back a read of the history goes when nothing else stops it, in pages of
// HISTORY_PAGE. Skipped messages cost no token budget, so a long Session that is mostly
// Bot messages reads to the start; a full read decompresses tens of megabytes of log,
// and a few Bots reading at once exhaust the host's heap.
export const HISTORY_SCAN_PAGES = 10
// Shown when an aside stops at the route's own output limit. The partial answer stays.
export const ASIDE_LIMIT = 'Answer cut off at the output limit.'

export const STEER_CUT = 'ds-bot/steer'
