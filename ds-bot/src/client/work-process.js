// How much of a Bot's work its chat shows, and how those rows fold. The mode is DS
// Bot's own preference (`workProcess`); the folding follows DSH's work-details setting
// (`transcriptView` in the `ui-chat` namespace), so a Bot chat reads like the
// conversation around it. Everything here is a pure function over what the transcript
// hands the client, so the rows can be tested without a browser.
import { contentText, toolArgs, toolName } from './text.js'

export const WORK_PROCESS_MODES = ['off', 'thinking', 'full']
// Rows by default: a chat that hides what the Bot did reads as if the answer came from
// nowhere. `thinking` keeps the live phrase of a running call and no row, and `off`
// leaves the chat to the messages alone.
export const DEFAULT_WORK_PROCESS_MODE = 'full'
export const TRANSCRIPT_VIEWS = ['compact', 'standard', 'detailed', 'verbose']
export const DEFAULT_TRANSCRIPT_VIEW = 'standard'

// The calls a Bot chat draws whatever the mode. A PTC program (`run_code`) dispatches
// the real tools as its sub-calls, so a call draws by its own name wherever it sits in
// the tree. These are the team's own events and the cards the user answers.
const DRAWN = new Set(['message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret', 'request_connector', 'mail_send', 'ask_user_question', 'show_view', 'browser_handoff', 'read_group_chat', 'bot_remember', 'bot_forget', 'remember', 'forget'])
// Calls whose card a dock above the composer carries when the call is not drawn.
export const CARDS = new Set(['ask_user', 'request_secret', 'request_connector', 'mail_send', 'show_view', 'browser_handoff', 'computer_handoff'])

export const isComputerCall = name => name === 'cua' || name?.startsWith('cua_driver_native__') === true

// A team event, a card or a computer call draws itself, whatever calls hang under it.
const drawsItself = name => DRAWN.has(name) || CARDS.has(name) || isComputerCall(name)
// A program (`run_code`) is a container: its sub-calls are the work it dispatched, so it
// has no row of its own, and a program that dispatched nothing leaves nothing to show.
export const isContainer = (call) => {
  const name = toolName(call)
  return !drawsItself(name) && (name === 'run_code' || (call?.subCalls?.length ?? 0) > 0)
}
// A work row is every other call: a shell command, a file read, a search. The mode
// decides whether the rows are drawn.
export const isWorkCall = (call) => {
  const name = toolName(call)
  return !drawsItself(name) && !isContainer(call)
}
// A container keeps its node alive while anything under it draws.
const drawsDeep = (call, mode) => (isContainer(call) ? (call.subCalls ?? []).some(child => drawsDeep(child, mode)) : mode === 'full' || !isWorkCall(call))
// A leading argument that names what the call works on, in the order a chat reads it.
const DETAIL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'to', 'group', 'name', 'description', 'prompt', 'code', 'script', 'text']

const oneLine = (text, limit) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat
}

/**
 * The chat's saved work-process mode; a value this version does not know reads as the default.
 * @param prefs - DS Bot's preference record.
 * @returns one of {@link WORK_PROCESS_MODES}.
 */
export function workProcessOf(prefs) {
  return WORK_PROCESS_MODES.includes(prefs?.workProcess) ? prefs.workProcess : DEFAULT_WORK_PROCESS_MODE
}

/**
 * DSH's work-details mode, with the values of the two-mode generation read as `detailed`.
 * @param value - the saved `transcriptView`, possibly a legacy value or nothing.
 * @returns one of {@link TRANSCRIPT_VIEWS}.
 */
export function transcriptViewOf(value) {
  if (value === 'normal' || value === 'expanded') return 'detailed'
  return TRANSCRIPT_VIEWS.includes(value) ? value : DEFAULT_TRANSCRIPT_VIEW
}

/**
 * How a chat draws the work rows under one tool-call node.
 * @param mode - DS Bot's work-process mode.
 * @param transcriptView - DSH's work-details mode.
 * @returns `none` for no rows, `folded` closed until the user opens them, `live` open
 * while the turn runs and folded once it is done, `open` always expanded.
 */
export function foldingOf(mode, transcriptView) {
  if (mode !== 'full') return 'none'
  switch (transcriptViewOf(transcriptView)) {
    case 'verbose': return 'open'
    case 'detailed': return 'live'
    default: return 'folded'
  }
}

/**
 * The calls a tool-call node draws, in dispatch order.
 * @param calls - the node's calls, root and sub-calls.
 * @param options.mode - DS Bot's work-process mode; the default draws the work rows.
 * @returns a new list: every event and card call, plus the work calls in `full`.
 */
export function drawnCalls(calls, options = {}) {
  const mode = options.mode ?? DEFAULT_WORK_PROCESS_MODE
  const list = calls ?? []
  return mode === 'full' ? [...list] : list.filter(call => drawsDeep(call, mode))
}

/**
 * One work row's text: what the call works on, and what it answered.
 * @param call - one tool call, running or settled.
 * @param options.detailLimit - characters kept from the argument.
 * @param options.resultLimit - characters kept from the result.
 * @returns the call's name, a one-line argument, a one-line result, whether it failed,
 * and how long it took in ms (absent while it runs, and when the call head is gone).
 */
export function callSummary(call, options = {}) {
  const { detailLimit = 80, resultLimit = 140 } = options
  const done = call?.kind === 'tool-result'
  const arg = toolArgs(call ?? {}).text
  let detail = ''
  for (const key of DETAIL_KEYS) {
    const value = arg(key)
    if (typeof value === 'string' && value.trim() !== '') { detail = oneLine(value, detailLimit); break }
  }
  // A call whose head left the loaded window has its own start time only on the
  // result, so a duration of 0 is the honest answer there.
  const started = Number.isFinite(call?.callTime) ? call.callTime : Number(call?.time)
  const ended = Number(call?.time)
  const duration = done && Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : undefined
  return {
    tool: toolName(call ?? {}) ?? '',
    detail,
    result: done ? oneLine(contentText(call.content), resultLimit) : '',
    failed: done && call.isError === true,
    duration,
  }
}
