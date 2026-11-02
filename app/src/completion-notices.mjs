// What each Host event kind says in the notification. Kinds come from the Host plugin.
// An approval or a question also quotes what it asks, so that it can be answered from the
// notification; the other kinds name only the event.
const BODIES = {
  completion: 'Task completed',
  approval: 'Waiting for your approval',
  question: 'Waiting for your answer',
  view: 'A view waits for your answer',
  secret: 'Waiting for a secret',
  failure: 'The task failed',
}

// A Windows notification has room for three answer buttons; a longer list becomes a dropdown.
const BUTTON_LIMIT = 3
const LABEL_LIMIT = 60
const SHOWN_LIMIT = 500

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const hasTool = event => typeof event.tool === 'string' && event.tool !== ''
const hasQuestion = event => typeof event.question === 'string' && event.question.trim() !== ''
// A group member's approval is answered by the team; a Bot's own approval waits for DSH's card in its chat.
const answersHere = event => typeof event.roomId === 'string'

function bodyOf(event) {
  if (event.kind === 'approval' && hasTool(event)) {
    const command = event.detail?.code ? `: ${clip(event.detail.code, 120)}` : ''
    const why = [event.detail?.text, event.reason].filter(Boolean).join(' · ')
    const where = answersHere(event) ? '' : ' (answer it in the chat)'
    return `Allow ${event.tool}${command}${why ? ` — ${clip(why, 120)}` : ''}${where}`
  }
  if (event.kind === 'question' && hasQuestion(event)) {
    const detail = event.detail ? ` (${clip(event.detail, 80)})` : ''
    const several = event.multiSelect === true ? ' (choose several in the app)' : ''
    return `${clip(event.question.trim(), 160)}${detail}${several}`
  }
  return BODIES[event.kind] ?? BODIES.completion
}

// The controls a notice offers, and the answer each one gives. The Host checks every answer;
// a notice only names the option that was picked.
function controlsOf(event, platform) {
  const none = { actions: [], reply: false, choose: () => undefined }
  if (event.kind === 'approval') {
    if (!answersHere(event)) return none
    const choices = ['allow', 'reject']
    return { ...none,
      actions: [{ type: 'button', text: 'Allow once' }, { type: 'button', text: 'Reject' }],
      choose: index => (choices[index] === undefined ? undefined : { choice: choices[index] }) }
  }
  if (event.kind !== 'question') return none
  const reply = event.allowCustom === true
  const options = Array.isArray(event.options) ? event.options.filter(label => typeof label === 'string' && label !== '') : []
  // Several answers cannot be picked with buttons or one dropdown choice; they are typed instead.
  if (event.multiSelect === true || options.length === 0) return { ...none, reply }
  if (platform === 'win32' && options.length > BUTTON_LIMIT) {
    return { ...none, reply,
      actions: [{ type: 'selection', text: 'Send', items: options.map(label => clip(label, LABEL_LIMIT)) }],
      choose: (index, picked) => (index === 0 ? { selected: options[picked] === undefined ? [] : [options[picked]] } : undefined) }
  }
  return { ...none, reply,
    actions: options.map(label => ({ type: 'button', text: clip(label, LABEL_LIMIT) })),
    choose: index => (options[index] === undefined ? undefined : { selected: [options[index]] }) }
}

export function completionNotices({ Notification, window, open, navigate, answer, platform = process.platform }) {
  const shown = new Set()
  const live = new Set()
  // The notices that take an answer, until the Host reports how the answer went.
  const asked = new Map()
  let current = null
  const deliver = (event, { body, actions = [], reply = false }) => {
    const note = new Notification({
      title: event.name,
      body,
      silent: false,
      ...(actions.length > 0 ? { actions } : {}),
      ...(reply ? { hasReply: true, replyPlaceholder: 'Type your own answer' } : {}),
    })
    live.add(note)
    note.on('click', () => { open(); navigate(event.roomId ?? event.botId) })
    note.on('close', () => live.delete(note))
    note.on('failed', () => live.delete(note))
    note.show()
    return note
  }
  const send = (event, fields) => {
    asked.set(event.id, event)
    if (asked.size > SHOWN_LIMIT) asked.delete(asked.keys().next().value)
    try {
      if (typeof answer !== 'function') throw new Error('The Bot team is not running.')
      answer({ type: 'ds-bot:attention-answer', id: event.id, kind: event.kind, sessionId: event.sessionId, ...fields })
    } catch (error) {
      asked.delete(event.id)
      if (Notification.isSupported()) deliver(event, { body: error.message })
    }
  }
  return {
    supported: () => Notification.isSupported(),
    current: id => { current = id },
    show(event) {
      if (shown.has(event.id)) return false
      shown.add(event.id)
      if (shown.size > SHOWN_LIMIT) shown.delete(shown.values().next().value)
      const win = window()
      if (win && win.isVisible() && win.isFocused() && current === event.sessionId) return false
      if (!Notification.isSupported()) return false
      const controls = controlsOf(event, platform)
      const note = deliver(event, { body: bodyOf(event), actions: controls.actions, reply: controls.reply })
      note.on('action', (details, index) => {
        const fields = controls.choose(details?.actionIndex ?? index, details?.selectionIndex ?? -1)
        if (fields !== undefined) send(event, fields)
      })
      note.on('reply', (details, text) => send(event, { selected: [], custom: String(details?.reply ?? text ?? '').trim() }))
      return true
    },
    // The Host's word on an answer. A refused answer is said in a notice of its own.
    result(message) {
      const event = asked.get(message?.id)
      asked.delete(message?.id)
      if (event === undefined || message.ok === true) return
      if (Notification.isSupported()) deliver(event, { body: message.error || 'The answer was not sent.' })
    },
  }
}
