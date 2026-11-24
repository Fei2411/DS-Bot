import { createElement as h, useEffect, useRef, useState } from 'react'
import { fnv1a, lookOf, shapeId, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from './characters.js'
import { reducedEffects, reducedMotion } from './motion.js'
import { memo } from './memo.js'
import { t } from './i18n.js'

export { colorOf, lookOf } from './characters.js'

// -------------------------------------------------------------------------
// Bot mark: the Bot's character (or its uploaded photo), looked up by lookOf.

// Mascot states: what the Bot is doing picks the
// motion. Uploaded images only bob or hop, since they have no parts to move. `waiting`:
// no turn runs, but work it handed on has not come back yet.
const STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done']
export const botState = (running, activity, alert) => (running ? (STATES.includes(activity) && activity !== 'waiting' ? activity : 'working')
  : alert ? 'alert' : activity === 'waiting' ? 'waiting' : 'idle')
export const toolState = name => (/^(message_bot|delegate_work|ask_back|answer_work|cancel_work|note_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(name) ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name) ? 'searching' : 'working')

// Shared gaze manager: one pointermove, one MutationObserver, one matchMedia listener,
// and one IntersectionObserver across all BotMark instances with gaze=true.
// Reads all bounding rects before writing --bt-gx/--bt-gy, and skips unchanged values.
const gazeEntries = new Map()
const gazeHub = {
  frame: 0,
  point: null,
  active: false,
  mounted: false,
  mutationObserver: null,
  intersectionObserver: null,
  media: null,
}

const gazeDisabled = () => reducedEffects() || document.body?.dataset.btMotion === 'quiet'
const clampGaze = value => Math.max(-1, Math.min(1, value))

function flushGaze() {
  gazeHub.frame = 0
  const point = gazeHub.point
  if (!point || gazeDisabled()) return
  const measured = []
  for (const entry of gazeEntries.values()) {
    if (!entry.visible || !entry.node.isConnected) continue
    measured.push([entry, entry.node.getBoundingClientRect()])
  }
  for (const [entry, box] of measured) {
    const gx = clampGaze((point.x - box.left - box.width / 2) / 160).toFixed(2)
    const gy = clampGaze((point.y - box.top - box.height / 2) / 160).toFixed(2)
    if (gx !== entry.gx) { entry.gx = gx; entry.node.style.setProperty('--bt-gx', gx) }
    if (gy !== entry.gy) { entry.gy = gy; entry.node.style.setProperty('--bt-gy', gy) }
  }
}

function onGazeMove(event) {
  if (gazeDisabled()) return
  gazeHub.point = { x: event.clientX, y: event.clientY }
  if (!gazeHub.frame) gazeHub.frame = requestAnimationFrame(flushGaze)
}

function onGazeLeave() {
  gazeHub.point = null
  for (const entry of gazeEntries.values()) {
    if (entry.gx !== '0') { entry.gx = '0'; entry.node.style.setProperty('--bt-gx', '0') }
    if (entry.gy !== '0') { entry.gy = '0'; entry.node.style.setProperty('--bt-gy', '0') }
  }
}

function clearGazeOffsets() {
  gazeHub.point = null
  if (gazeHub.frame) { cancelAnimationFrame(gazeHub.frame); gazeHub.frame = 0 }
  for (const entry of gazeEntries.values()) {
    if (entry.gx !== '') { entry.gx = ''; entry.node.style.removeProperty('--bt-gx') }
    if (entry.gy !== '') { entry.gy = ''; entry.node.style.removeProperty('--bt-gy') }
  }
}

function attachGazePointer() {
  if (gazeHub.active) return
  gazeHub.active = true
  window.addEventListener('pointermove', onGazeMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onGazeLeave)
}

function detachGazePointer() {
  if (!gazeHub.active) return
  gazeHub.active = false
  window.removeEventListener('pointermove', onGazeMove)
  document.documentElement.removeEventListener('pointerleave', onGazeLeave)
  clearGazeOffsets()
}

function syncGazeHub() {
  if (gazeEntries.size === 0 || gazeDisabled()) detachGazePointer()
  else attachGazePointer()
}

function mountGazeHub() {
  if (gazeHub.mounted) return
  gazeHub.mounted = true
  if (typeof MutationObserver === 'function' && document.body) {
    gazeHub.mutationObserver = new MutationObserver(syncGazeHub)
    gazeHub.mutationObserver.observe(document.body, { attributes: true, attributeFilter: ['data-bt-effects', 'data-bt-motion'] })
  }
  if (typeof IntersectionObserver === 'function') {
    gazeHub.intersectionObserver = new IntersectionObserver((records) => {
      for (const record of records) {
        const entry = gazeEntries.get(record.target)
        if (entry) entry.visible = record.isIntersecting
      }
    })
  }
  gazeHub.media = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  gazeHub.media?.addEventListener?.('change', syncGazeHub)
  syncGazeHub()
}

function unmountGazeHub() {
  if (!gazeHub.mounted) return
  gazeHub.mounted = false
  gazeHub.mutationObserver?.disconnect()
  gazeHub.mutationObserver = null
  gazeHub.intersectionObserver?.disconnect()
  gazeHub.intersectionObserver = null
  gazeHub.media?.removeEventListener?.('change', syncGazeHub)
  gazeHub.media = null
  detachGazePointer()
}

// Eyes follow the pointer on large marks.
function useGaze(ref, enabled) {
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node) return undefined
    const entry = { node, gx: '', gy: '', visible: true }
    gazeEntries.set(node, entry)
    mountGazeHub()
    gazeHub.intersectionObserver?.observe(node)
    return () => {
      gazeHub.intersectionObserver?.unobserve(node)
      gazeEntries.delete(node)
      node.style.removeProperty('--bt-gx')
      node.style.removeProperty('--bt-gy')
      if (gazeEntries.size === 0) unmountGazeHub()
    }
  }, [enabled])
}

const sameLook = (a, b) => a === b || (a?.shape === b?.shape && a?.color === b?.color && a?.image === b?.image)
const sameBotLook = (a, b) => a === b || (
  a?.id === b?.id
  && a?.color === b?.color
  && a?.avatar?.shape === b?.avatar?.shape
  && a?.avatar?.color === b?.avatar?.color
  && a?.avatar?.image === b?.avatar?.image
)

// A mark moves for its state. `live` marks (sidebar, header, details) also answer the
// pointer, and at the lively motion level blink and fidget at rest (each Bot its own
// fidget and moment); transcript marks stay still so a long chat does not run dozens
// of animations.
const FIDGETS = ['hop', 'sway', 'stretch', 'look']
export const BotMark = memo(function BotMark({ bot, look: given, size = 36, state = 'idle', live = false, gaze = false, pokeable = false, label }) {
  const look = given ?? lookOf(bot)
  const ref = useRef(null)
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-mark-${nextMarkSerial()}`
  const [poked, setPoked] = useState(false)
  // A photo that does not load shows the character instead; a new photo is tried again.
  const [broken, setBroken] = useState('')
  const image = look.image && look.image !== broken ? look.image : undefined
  useGaze(ref, gaze && !image)
  const common = {
    ref,
    className: poked ? 'bt-mark bt-mark-poke' : 'bt-mark',
    'data-shape': image ? 'image' : shapeId(look.shape),
    'data-state': STATES.includes(state) ? state : 'idle',
    'data-live': live ? '' : undefined,
    'data-fidget': live ? FIDGETS[fnv1a(`${bot?.id ?? ''}:fidget`) % FIDGETS.length] : undefined,
    'data-gaze': gaze && !image ? '' : undefined,
    'data-poke': pokeable ? '' : undefined,
    style: { width: size, height: size, ...(live ? { '--bt-delay': `${-(fnv1a(String(bot?.id ?? '')) % 5000) / 1000}s`, '--bt-fidget-delay': `${-(fnv1a(`${bot?.id ?? ''}:when`) % 9000) / 1000}s` } : {}) },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => { if (!reducedMotion() && document.body?.dataset.btMotion !== 'quiet') setPoked(true) } : undefined,
    onAnimationEnd: poked ? (event) => { if (event.animationName.startsWith('bt-poke')) setPoked(false) } : undefined,
    onAnimationCancel: poked ? () => setPoked(false) : undefined,
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
function useSettled(state, id) {
  const prev = useRef({ state, id })
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = { state, id }
    if (was.id !== id || state !== 'idle') { setSettled(false); return undefined }
    if (was.state === 'idle' || was.state === 'alert') return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), 1800)
    return () => clearTimeout(timer)
  }, [state, id])
  return settled
}

export const BotAvatar = memo(function BotAvatar({ bot, size, state = 'idle', main, admin, badge = true, live = true, gaze = false, pokeable = false }) {
  const settled = useSettled(state, bot?.id)
  if (bot === undefined) return h(BotMark, { size })
  const badgeKind = !badge ? null : state === 'alert' ? 'alert' : state !== 'idle' && state !== 'waiting' ? 'working' : admin ? 'admin' : main ? 'main' : null
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
