// DSH opens the tab of a terminal an Agent starts from the Session header: the
// terminal plugin's `agent-terminals` entry in `conversation.session.header.actions`
// watches the Session's terminals while it is mounted. The Bot header replaces
// that header but may not render the list: a child slot renders only from the
// entry that declares it, and DSH's own header keeps that declaration. So the Bot
// header borrows the entry's watch, and the plugin still places and binds the tabs.
const ACTIONS = 'conversation.session.header.actions'
const AGENT_TERMINALS = 'agent-terminals'

const opener = slots => slots.entries(ACTIONS).find(entry => entry.options?.id === AGENT_TERMINALS) ?? null

// The entry can arrive after the header mounts, or come back on a plugin reload.
export function watchAgentTerminals(slots, sessionId, onError) {
  let entry = null
  let release
  const refresh = () => {
    const next = opener(slots)
    if (next === entry) return
    release?.()
    release = undefined
    entry = next
    try {
      const watch = entry?.inject?.(sessionId)?.watchAgentTerminals
      if (typeof watch === 'function') release = watch()
    } catch (error) {
      onError?.(error)
    }
  }
  const unsubscribe = slots.subscribe(ACTIONS, refresh)
  refresh()
  return () => { unsubscribe(); release?.() }
}
