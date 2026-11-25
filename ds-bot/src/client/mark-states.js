// Mark states: what a Bot is doing picks its mark's motion (avatar/states.js). No React
// or page here, so the phone app maps a Bot's work to the same states. `waiting`: no
// turn runs, but work it handed on has not come back yet. `orbit`: relaying messages in
// a group.
export const MARK_STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done']
export const botState = (running, activity, alert) => (running ? (MARK_STATES.includes(activity) && activity !== 'waiting' ? activity : 'working')
  : alert ? 'alert' : activity === 'waiting' ? 'waiting' : 'idle')
export const toolState = name => (/^(message_bot|delegate_work|ask_back|answer_work|cancel_work|note_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(name) ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name) ? 'searching' : 'working')
