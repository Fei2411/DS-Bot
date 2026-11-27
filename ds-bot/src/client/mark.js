import { createElement as h, useEffect, useRef, useState } from 'react'
import { fnv1a, lookOf, shapeId, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from './characters.js'
import { LiveMark } from './avatar/live.js'
import { MARK_STATES as STATES, avatarBadge, botState, isBrowserHandoff, isComputerHandoff, toolState } from './mark-states.js'
import { memo } from './memo.js'
import { currentPart, turnOutlineOf } from './text.js'
import { t } from './i18n.js'

export { colorOf, lookOf } from './characters.js'

// -------------------------------------------------------------------------
// Bot mark: the Bot's character (or its uploaded photo), looked up by lookOf.
//
// The flat art (characters.js) paints first and stays for marks at rest. A mark that
// moves gets a live layer (avatar/live.js): the character's 3D model turned and drawn
// by the avatar engine, from the same pose, so nothing jumps when it takes over.

// Mark states (mark-states.js, shared with the phone app): what the Bot is doing picks
// the motion.
export { avatarBadge, botState, isBrowserHandoff, isComputerHandoff, toolState }
// The newest turn a part's live outline lists, or undefined while the list holds none.
export const latestTurnOf = (list, part) => {
  const outline = turnOutlineOf(list, part)
  return Array.isArray(outline) && outline.length > 0 ? outline.at(-1).turn : undefined
}
// Whether the Bot's last turn in its chat failed. The host keeps the failure under the
// part and turn it happened in until a turn there goes through, but the roster that
// carries it is polled, while the part's turn outline is live. So a non-blocking failure
// counts until a later turn shows in the outline: a retry under way, finished or stopped
// leaves it behind at once, as the chat's failure card does (turn-error.js). A turn the
// host could not number (picked up after a restart) cannot be placed, so it counts. A
// block (a key, a balance) stands for the whole Bot until the host clears it on a
// completed turn or provider fix: turnOutline records turn/start, so a retry that is
// manually stopped must not hide an active block.
export function lastTurnFailed(bot, latestTurn) {
  if (bot === undefined) return false
  if (bot.blocked !== undefined) return true
  const failure = bot.failures?.[currentPart(bot)]
  if (failure === undefined) return false
  return !(failure.turn >= 1 && latestTurn > failure.turn)
}

const useFalse = () => false
const hasPendingRequest = list => Array.isArray(list) && list.some(entry => entry?.status === 'pending')

// Pending user-action cards stored on the roster for one Bot's DM:
// skill / AGENTS.md learning proposals, secret / connector / mail approvals,
// and ask_user / show_view cards.
export function botPendingOf(roster, bot) {
  if (bot === undefined) return { learning: false, cardApproval: false, question: false }
  const id = bot.id
  const part = currentPart(bot)
  const learning = (roster?.learning?.[id]?.length ?? 0) > 0
  const cardApproval = hasPendingRequest(roster?.secretRequests?.[id])
    || hasPendingRequest(roster?.connectorRequests?.[id])
    || hasPendingRequest(roster?.mailRequests?.[id])
  const question = roster?.questions?.[part] !== undefined || roster?.views?.[part] !== undefined
  return { learning, cardApproval, question }
}

// Direct-chat foreground and background approvals for one Bot (excluding group approvals #1623).
export function useBotApprovals(botId, useWork, useComputer) {
  const useReadWork = useWork ?? useFalse
  const useReadComputer = useComputer ?? useFalse
  const fgTool = useReadWork(work => botId !== undefined && (work.approvals ?? []).some(entry => entry.roomId === undefined && entry.botId === botId && entry.taskId === undefined && entry.answerable !== false))
  const fgComputer = useReadComputer(comp => botId !== undefined && Object.values(comp?.asks ?? {}).some(ask => ask.roomId === undefined && ask.botId === botId))
  const bgApproval = useReadWork(work => botId !== undefined && (work.approvals ?? []).some(entry => entry.roomId === undefined && entry.botId === botId && entry.taskId !== undefined && entry.answerable !== false))
  return { fgApproval: fgTool || fgComputer, bgApproval }
}

// Active browser/computer handoff hold waiting for the user on one Bot.
export function useBotHandoff(botId, useBrowserHolds, useComputer) {
  const useReadBrowserHolds = useBrowserHolds ?? useFalse
  const useReadComputer = useComputer ?? useFalse
  const browserHandoff = useReadBrowserHolds(map => botId !== undefined && isBrowserHandoff(map?.[botId]))
  const computerHandoff = useReadComputer(comp => botId !== undefined && isComputerHandoff(comp?.holds?.[botId]))
  return browserHandoff || computerHandoff
}

// Unified direct-chat mark state shared by the sidebar row, header pill and details drawer.
// Blocking DM approvals/questions/handoffs override a running foreground turn; non-blocking items
// (background-task approvals, learning proposals) alert once idle without hiding foreground work.
export function dmMarkState({ running = false, doing, failed = false, background = false, waitingApproval = false, replied = false, fgApproval = false, bgApproval = false, handoff = false, pending = {} }) {
  const blockingAlert = Boolean(fgApproval || pending.cardApproval || pending.question || handoff)
  const alert = blockingAlert || Boolean(bgApproval || pending.learning || waitingApproval)
  const dmDoing = blockingAlert ? 'alert' : doing === 'alert' ? undefined : doing
  return botState(running, dmDoing, alert, { failed, background, replied })
}

// Where petting happens: a sidebar avatar or the About mark with a ring around it
// (`.bt-pet-zone`), or a mark that can be poked.
const PET_ZONE = ':is(.bt-row,.bt-tile)>:is(.bt-mark,.bt-cluster),.bt-pet-zone'

// The live layer: made once the mark has something to show (a state, life at rest, the
// pointer), kept until the mark goes, so it plays its way back to rest instead of
// jumping there when the state ends. Marks that follow the pointer share one listener
// in the live clock (avatar/live.js).
function useLive(ref, { look, image, size, state, live, gaze, pokeable, seed }) {
  const awake = useRef(false)
  if (live || gaze || pokeable || state !== 'idle') awake.current = true
  const shape = image ? `image:${image}` : look.shape
  useEffect(() => {
    const node = ref.current
    if (!awake.current || !node) return undefined
    const def = image ? undefined : shapeOf(look.shape)
    const mark = new LiveMark(node, { look: { shape: image ? 'image' : shapeId(look.shape), color: look.color }, def, size, seed, live, state, canvas: !image, follow: gaze })
    const zone = live || pokeable ? node.parentElement?.closest(PET_ZONE) ?? (node.matches(PET_ZONE) ? node : pokeable ? node : null) : null
    const enter = (event) => {
      const box = node.getBoundingClientRect()
      mark.act(engine => engine.pet(true, event.clientX < box.left + box.width / 2 ? -1 : 1))
    }
    const leave = () => mark.act(engine => engine.pet(false))
    zone?.addEventListener('pointerenter', enter)
    zone?.addEventListener('pointerleave', leave)
    return () => {
      zone?.removeEventListener('pointerenter', enter)
      zone?.removeEventListener('pointerleave', leave)
      mark.destroy()
    }
  }, [awake.current, shape])
  useEffect(() => { ref.current?.__btLive?.update({ look: image ? undefined : { shape: shapeId(look.shape), color: look.color }, def: image ? undefined : shapeOf(look.shape), size, live, state, follow: gaze }) }, [look.color, size, live, state, gaze])
}

const sameLook = (a, b) => a === b || (a?.shape === b?.shape && a?.color === b?.color && a?.image === b?.image)
const sameBotLook = (a, b) => a === b || (
  a?.id === b?.id
  && a?.color === b?.color
  && a?.avatar?.shape === b?.avatar?.shape
  && a?.avatar?.color === b?.avatar?.color
  && a?.avatar?.image === b?.avatar?.image
)

// A mark moves for its state. `live` marks (sidebar, header, details) also come alive at
// rest and answer the pointer; transcript marks move only for a state, so a long chat
// stays still. `gaze` follows the pointer; `pokeable` answers a click.
export const BotMark = memo(function BotMark({ bot, look: given, size = 36, state = 'idle', live = false, gaze = false, pokeable = false, label }) {
  const look = given ?? lookOf(bot)
  const ref = useRef(null)
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-mark-${nextMarkSerial()}`
  // A photo that does not load shows the character instead; a new photo is tried again.
  const [broken, setBroken] = useState('')
  const image = look.image && look.image !== broken ? look.image : undefined
  const markState = STATES.includes(state) ? state : 'idle'
  useLive(ref, { look, image, size, state: markState, live, gaze, pokeable, seed: fnv1a(String(bot?.id ?? look.shape)) })
  const common = {
    ref,
    className: 'bt-mark',
    'data-shape': image ? 'image' : shapeId(look.shape),
    'data-state': markState,
    'data-live': live ? '' : undefined,
    'data-poke': pokeable ? '' : undefined,
    style: { width: size, height: size },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => ref.current?.__btLive?.act(engine => engine.poke()) : undefined,
  }
  if (image) return h('span', common, h('img', { className: 'bt-mark-img', src: image, alt: '', draggable: false, onError: () => setBroken(image) }))
  const box = shapeOf(look.shape).size
  return h('span', common, h('svg', { viewBox: `0 0 ${box} ${box}`, dangerouslySetInnerHTML: { __html: characterMarkup(look.shape, look.color).replaceAll(MASK_ID, maskId.current) } }))
}, (a, b) => sameBotLook(a.bot, b.bot)
  && sameLook(a.look, b.look)
  && a.size === b.size
  && a.state === b.state
  && a.live === b.live
  && a.gaze === b.gaze
  && a.pokeable === b.pokeable
  && a.label === b.label, 'BotMark')

function StarIcon({ size = 8 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 10 10', 'aria-hidden': true },
    h('path', { d: 'M5 .6l1.3 2.8 3 .3-2.3 2 .7 3L5 7.2 2.3 8.7l.7-3L.7 3.7l3-.3z', fill: '#fff' }))
}
// The small star in a disc that marks a group admin, beside a name.
export function AdminStar() {
  return h('span', { className: 'bt-admin-star', role: 'img', 'aria-label': t('Admin') }, h(StarIcon, { size: 7 }))
}
// A Main Bot wears a large solid star; a group admin wears the small star in a disc.
function MainStar() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true },
    h('path', { d: 'M10 2.4l2.29 5.04 5.51.63-4.09 3.74 1.11 5.42L10 14.5l-4.82 2.73 1.11-5.42L2.2 8.07l5.51-.63z' }))
}

// Marks settle with a short squash when a run finishes.
// Done, for a moment, when a piece of work comes to an end: the Bot was busy and is now
// idle or has a reply waiting. Idle and an unread reply count as one (opening the chat
// reads the reply), so the moment runs its course across that change. A question
// answered or a failure is not work done.
const AFTER_WORK = new Set(['idle', 'replied'])
const NOT_WORK = new Set(['alert', 'failed'])
function useSettled(state, id) {
  const after = AFTER_WORK.has(state)
  const before = useRef({ state, id })
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const was = before.current
    before.current = { state, id }
    if (was.id !== id || !after) { setSettled(false); return undefined }
    if (AFTER_WORK.has(was.state) || NOT_WORK.has(was.state)) return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), 1800)
    return () => clearTimeout(timer)
  }, [after, id])
  // While the Bot is busy, the latest of what it does: a turn run after a failure is
  // work, and its end is done.
  useEffect(() => { if (!after) before.current = { state, id } })
  return settled
}

export const BotAvatar = memo(function BotAvatar({ bot, size, state = 'idle', main, admin, badge = true, live = true, gaze = false, pokeable = false }) {
  const settled = useSettled(state, bot?.id)
  if (bot === undefined) return h(BotMark, { size })
  const badgeKind = avatarBadge(state, { main, admin, badge })
  return h('span', { className: 'bt-mark', style: { width: size, height: size, '--bt-size': `${size}px` } },
    h(BotMark, { bot, size, state: settled ? 'done' : state, live, gaze, pokeable }),
    badgeKind === 'working' ? h('span', { className: 'bt-badge bt-badge-working', 'aria-label': t('Working'), role: 'img' }) : null,
    badgeKind === 'alert' ? h('span', { className: 'bt-badge bt-badge-alert', 'aria-label': t('Waiting for your answer'), role: 'img' }, '?') : null,
    badgeKind === 'admin' ? h('span', { className: 'bt-badge bt-badge-admin', 'aria-label': t('Admin'), role: 'img' }, h(StarIcon)) : null,
    badgeKind === 'main' ? h('span', { className: 'bt-badge bt-badge-main', 'aria-label': t('Main Bot'), role: 'img' }, h(MainStar)) : null)
}, (a, b) => sameBotLook(a.bot, b.bot)
  && a.size === b.size
  && a.state === b.state
  && a.main === b.main
  && a.admin === b.admin
  && a.badge === b.badge
  && a.live === b.live
  && a.gaze === b.gaze
  && a.pokeable === b.pokeable, 'BotAvatar')

// A group avatar seats its members' characters in the frame: two on a
// diagonal, three in a triangle, four in a grid, and past four three plus a "+N" seat.
function clusterSeats(count, frame) {
  if (count === 1) return [[0, 0, frame]]
  if (count === 2) return [[0, 0, frame * 2 / 3], [frame / 3, frame / 3, frame * 2 / 3]]
  if (count === 3) {
    const size = frame * 5 / 9
    const rest = frame - size
    return [[rest / 2, 0, size], [0, rest, size], [rest, rest, size]]
  }
  const half = frame / 2
  return [[0, 0, half], [half, 0, half], [0, half, half], [half, half, half]]
}

function sameRoomAvatar(a, b) {
  if (a.size !== b.size || a.room?.id !== b.room?.id || a.room?.avatar?.image !== b.room?.avatar?.image) return false
  const am = a.room?.members ?? []
  const bm = b.room?.members ?? []
  const aById = a.roster?.byId
  const bById = b.roster?.byId
  let ai = 0
  let bi = 0
  let visible = 0
  for (;;) {
    let aBot
    while (ai < am.length && !(aBot = aById?.[am[ai]])) ai += 1
    let bBot
    while (bi < bm.length && !(bBot = bById?.[bm[bi]])) bi += 1
    const aDone = ai >= am.length
    const bDone = bi >= bm.length
    if (aDone !== bDone) return false
    if (aDone) return true
    if (visible < 4 && !sameBotLook(aBot, bBot)) return false
    visible += 1
    ai += 1
    bi += 1
  }
}

export const RoomAvatar = memo(function RoomAvatar({ room, roster, size = 36 }) {
  const [broken, setBroken] = useState('')
  const image = room.avatar?.image
  if (image && image !== broken) return h('span', { className: 'bt-mark', style: { width: size, height: size }, 'aria-hidden': true },
    h('img', { className: 'bt-mark-img', src: image, alt: '', draggable: false, onError: () => setBroken(image) }))
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  // A group with one Bot left shows the user beside it.
  const people = members.length === 1 ? [members[0], null] : members
  const seat = (bot, seatSize, key) => (bot
    ? h(BotMark, { key, bot, size: seatSize })
    : h('span', { key, className: 'bt-cluster-you', style: { width: seatSize * 0.92, height: seatSize * 0.92, margin: seatSize * 0.04 } }))
  if (people.length === 0) return h(BotMark, { size })
  // Inline sizes have no room for a cluster, so the members line up instead.
  if (size <= 20 && people.length > 1) {
    return h('span', { className: 'bt-stack', style: { '--bt-stack-size': `${size}px` } },
      people.slice(0, 3).map((bot, index) => seat(bot, size, bot?.id ?? `you-${index}`)),
      people.length > 3 ? h('span', { className: 'bt-stack-more' }, `+${people.length - 3}`) : null)
  }
  const seats = clusterSeats(Math.min(people.length, 4), size)
  const overflow = people.length > 4 ? people.length - 3 : 0
  // A later seat cuts a gap of frame/14 into each seat it overlaps.
  const gap = size / 14
  const rings = seats.map(([x, y, s]) => ({ cx: x + s / 2, cy: y + s / 2, r: s * 0.48 + gap }))
  return h('span', { className: 'bt-cluster', style: { width: size, height: size } },
    seats.map(([x, y, s], index) => {
      const holes = rings.slice(index + 1)
        .filter(ring => Math.hypot(ring.cx - x - s / 2, ring.cy - y - s / 2) < ring.r + s * 0.46)
        .map(ring => `radial-gradient(circle at ${ring.cx - x}px ${ring.cy - y}px,transparent ${ring.r}px,#000 ${ring.r + 0.5}px)`)
      const style = { left: x, top: y, width: s, height: s }
      if (holes.length > 0) Object.assign(style, { WebkitMaskImage: holes.join(','), maskImage: holes.join(','), WebkitMaskComposite: 'source-in', maskComposite: 'intersect' })
      if (overflow > 0 && index === 3) {
        return h('span', { key: 'more', className: 'bt-cluster-more', style: { ...style, width: s * 0.92, height: s * 0.92, margin: s * 0.04, fontSize: Math.max(8, Math.round(s * 0.36)) } }, `+${overflow}`)
      }
      const bot = people[index]
      return h('span', { key: bot?.id ?? 'you', style }, seat(bot, s))
    }))
}, sameRoomAvatar, 'RoomAvatar')
