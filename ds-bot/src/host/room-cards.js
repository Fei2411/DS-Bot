// Room cards: the ask_user and show_view cards a member shows in a group chat.
//
// A card asked inside a group belongs to the group, not to the member's hidden group
// Session: the group view looks it up by room id, and the answer goes back to the
// member that asked. The member's turn has already ended when the card appears (a tool
// cannot hold a DSH turn open), so "paused" means: the round marks the member's slot
// `waiting-answer`, the group carries on with everyone else, and the user's answer
// starts a new turn in the member's hidden group Session, whose output posts back into
// the group through the usual late-reply path.
//
// Cards live in `state.roomCards[roomId]`, ordered by when they were asked. A key card
// (request_secret) waits in `state.secretRequests` per Bot and is mirrored here under the
// same id, so the group dock can show it; the request stays the source of truth for who
// may use the key, and the mirror only for what the group is waiting on.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'

// What makes two cards the same, so a repeated call does not queue twice. Two
// different questions from one member are both kept: a member that asked, was mentioned
// again and asked something else has two legitimate cards waiting.
function cardKey(card) {
  if (card.kind === 'secret') return JSON.stringify(['secret', card.name, card.requestKind ?? 'fill'])
  return card.kind === 'view'
    ? JSON.stringify(['view', card.title, card.view])
    : JSON.stringify(['question', card.question, card.detail ?? '', card.options, card.multiSelect === true, card.allowCustom === true])
}

export function install(rt) {
  const { ctx, state } = rt

  const cardsOf = roomId => (roomId === undefined ? [] : state.roomCards?.[roomId] ?? [])

  // The cards a caller may read without creating the room's list.
  const cardOf = (roomId, cardId) => cardsOf(roomId).find(card => card.id === cardId)

  // Adds a card unless the same member already waits with the same one in that group.
  // Returns the card it kept and whether it was already there.
  const addCard = (card) => {
    const list = (state.roomCards[card.roomId] ??= [])
    const key = cardKey(card)
    const same = list.find(other => other.botId === card.botId && cardKey(other) === key)
    if (same !== undefined) return { card: same, duplicate: true }
    list.push(card)
    return { card, duplicate: false }
  }

  // Takes a card out so a second answer is refused, and hands back where it was, so a
  // failed delivery can put it back.
  const dropCard = (roomId, cardId) => {
    const list = state.roomCards?.[roomId]
    if (list === undefined) return undefined
    const at = list.findIndex(card => card.id === cardId)
    if (at === -1) return undefined
    const [card] = list.splice(at, 1)
    if (list.length === 0) delete state.roomCards[roomId]
    return { card, at }
  }

  const restoreCard = ({ card, at }) => {
    const list = (state.roomCards[card.roomId] ??= [])
    list.splice(Math.min(at ?? list.length, list.length), 0, card)
  }

  // A group or a member leaving takes its cards with it.
  const dropCards = ({ roomId, botId }) => {
    const list = state.roomCards?.[roomId]
    if (list === undefined) return []
    const kept = botId === undefined ? [] : list.filter(card => card.botId !== botId)
    const gone = list.filter(card => !kept.includes(card))
    if (kept.length === 0) delete state.roomCards[roomId]
    else state.roomCards[roomId] = kept
    return gone
  }

  // The user's answer to a card, as the message that starts the asking member's next
  // turn in its hidden group Session. `text` is what the member reads; `note` names the
  // event in the header line. The source keeps the answer's own kind (so the member's
  // history reads it as an answer) and carries role 'room', which is what makes the
  // turn's output post into the group as a late reply.
  //
  // A format v4 Session message requires a producer-owned `source.kind`, and a caller
  // that has no answer of its own (a skip, a secret note) passes no source. The defaults
  // below supply it, so an omitted source cannot write an unreadable message into the
  // member's log; an explicit source still wins. Upstream 0.3.x builds the same shape in
  // delivery.js, so a card note and a relayed message reach the Session alike.
  const deliverCardNote = async (room, card, text, { note, source = {} } = {}) => {
    const sessionId = room.sessions?.[card.botId]
    if (sessionId === undefined) throw Object.assign(new Error('The member is no longer in this group chat'), { code: 'bot/stale' })
    await rt.ensureCapabilities(sessionId)
    const agent = await rt.resolveAgent(sessionId)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group chat "${room.name}" · ${note}]\n${text}` }],
      source: { kind: SOURCE_KIND, form: 'relay', senderName: 'You', ...source, role: 'room', roomId: room.id, exchangeId: randomUUID(), senderRoomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }

  // The user's choice goes into the group log, so the members' next turns and
  // read_group_chat see it after the round that asked is long over. It is a `kind` line,
  // which the preview leaves out. The ledger is the record now: the group view reads the
  // line back through rowsView/groupRows, so nothing else is needed at write time.
  const appendAnswerLine = (room, text) => {
    if (typeof rt.appendRoomLine !== 'function') return
    rt.appendRoomLine(room, { who: 'User', kind: 'answer', text })
  }

  // What the phone and the group view may know about waiting cards, without their text.
  const asksView = () => {
    const view = {}
    for (const [roomId, list] of Object.entries(state.roomCards ?? {})) {
      if (!Array.isArray(list) || list.length === 0) continue
      view[roomId] = list.map(card => ({ botId: card.botId, cardId: card.id, kind: card.kind, at: card.askedAt }))
    }
    return view
  }

  Object.assign(rt, {
    roomCardsOf: cardsOf,
    roomCardOf: cardOf,
    addRoomCard: addCard,
    dropRoomCard: dropCard,
    restoreRoomCard: restoreCard,
    dropRoomCards: dropCards,
    deliverRoomCardNote: deliverCardNote,
    appendRoomAnswer: appendAnswerLine,
    roomAsksView: asksView,
    roomCardsView: () => state.roomCards ?? {},
  })
}
