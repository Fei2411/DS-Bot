// Mark states: what a Bot is doing picks its mark's motion (avatar/states.js), and the
// motion alone says it; no state needs a badge or a line of text to read. No React or
// page here, so the phone app maps a Bot's work to the same states. `waiting`: no turn
// runs, but work it handed on has not come back yet. `orbit`: relaying messages in a
// group. Between turns, in this order: a question for you (`alert`), a last turn that
// failed (`failed`), work handed on (`waiting`), background tasks running
// (`background`), a reply you have not read (`replied`).
export const MARK_STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'background', 'alert', 'failed', 'done', 'replied']
// States that wear the working badge.
export const RUNNING_STATES = new Set(['thinking', 'searching', 'working', 'sending', 'orbit', 'done'])
// States between turns; a running turn shows what it does instead.
const BETWEEN = new Set(['waiting', 'background', 'failed', 'replied'])
export const botState = (running, activity, alert, { failed = false, background = false, replied = false } = {}) => (running
  ? (MARK_STATES.includes(activity) && !BETWEEN.has(activity) ? activity : 'working')
  : alert ? 'alert' : failed ? 'failed' : activity === 'waiting' ? 'waiting' : background ? 'background' : replied ? 'replied' : 'idle')
export const toolState = name => (/^(message_bot|delegate_work|ask_back|answer_work|cancel_work|note_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(name) ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name) ? 'searching' : 'working')
// One badge at a time, derived from the mark's state: waiting for you > working > admin > Main Bot.
export const avatarBadge = (state, { main = false, admin = false, badge = true } = {}) => (
  !badge ? null : state === 'alert' ? 'alert' : RUNNING_STATES.has(state) ? 'working' : admin ? 'admin' : main ? 'main' : null
)
export const isBrowserHandoff = hold => hold?.callId !== undefined
export const isComputerHandoff = hold => hold != null && (hold.by === 'bot' || hold.fromBot === true || hold.callId !== undefined || (typeof hold.reason === 'string' && hold.reason !== '' && hold.reason !== 'takeover'))
