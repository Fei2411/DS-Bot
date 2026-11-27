import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { characterMarkup, fnv1a, lookOf, MASK_ID, shapeId, shapeOf } from '../../../ds-bot/src/client/characters.js'
import { INKS } from '../../../ds-bot/src/client/inks.js'
import { MARK_STATES } from '../../../ds-bot/src/client/mark-states.js'
import type { Bot, Room } from '../connection.ts'
import { LiveMark } from './avatar/LiveMark.tsx'
import { badgeOf } from './badge.ts'
import { MainStarIcon } from './icons.tsx'
import { isAfterWorkState, shouldCelebrateSettle } from '../team/mark-state.ts'

// The Bot's own mascot, drawn by the same generator as the desktop mark
// (ds-bot/src/client/characters.js). CSS ink variables resolve to the mode's color.
// A mark that moves (a state, life at rest, a touch) turns into a live mark
// (avatar/LiveMark.tsx): the character's model moved by the desktop's avatar engine.

let serial = 0

// A character color as paint, for swatches and a member's name in a group.
export const COLOR_PAINT: Record<string, string> = {
  black: '#3c4048', brown: '#8d6e57', red: '#e5484d', orange: '#f76b15', yellow: '#d4a017',
  green: '#30a46c', cyan: '#12a5b4', blue: '#4f7df3', violet: '#7d5aff', magenta: '#d3458b', gray: '#8b8f98',
  aurora: '#5cc8a0',
}

const lookSvg = (look: { shape: string; color: string; image?: string }, dark: boolean): string => {
  const box = shapeOf(look.shape).size
  const id = `pm${serial += 1}`
  const inner = characterMarkup(look.shape, look.color).replaceAll(MASK_ID, id)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${inner}</svg>`
  const inks = INKS as Record<string, string[]>
  return svg.replace(/var\(--bt-ink-(\w+)\)/g, (_match, name: string) => (inks[name] ?? inks.gray)[dark ? 1 : 0])
}

type MarkLook = { shape: string; color: string; image?: string }
export interface MotionProps {
  // What the Bot is doing (mark-states.js): working, thinking, alert, done, and so on.
  state?: string
  // Comes alive at rest too, at the lively motion level (the list, the header, details).
  live?: boolean
  // A tap pokes it and a held touch pets it.
  pokeable?: boolean
}

function FlatMark({ look, dark, size }: { look: MarkLook; dark: boolean; size: number }) {
  const xml = useMemo(() => lookSvg(look, dark), [look.shape, look.color, dark])
  if (typeof look.image === 'string' && look.image.startsWith('data:')) {
    return <Image source={{ uri: look.image }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  }
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  )
}

export function Mark({ look, dark, size = 24, seed, state = 'idle', live = false, pokeable = false, label }: { look: MarkLook; dark: boolean; size?: number; seed?: string; label?: string } & MotionProps) {
  const markState = MARK_STATES.includes(state) ? state : 'idle'
  // Made once the mark has something to show, and kept until it goes, so it plays its
  // way back to rest instead of jumping there when the state ends.
  const awake = useRef(false)
  if (live || pokeable || markState !== 'idle') awake.current = true
  const flat = <FlatMark look={look} dark={dark} size={size} />
  if (!awake.current) return flat
  const photo = typeof look.image === 'string' && look.image.startsWith('data:')
  const id = shapeId(look.shape)
  return (
    <LiveMark look={photo ? { shape: 'image', color: look.color, image: look.image } : { shape: id, color: look.color }} def={photo ? undefined : shapeOf(look.shape)}
      dark={dark} size={size} seed={fnv1a(seed ?? look.shape)} state={markState} live={live} pokeable={pokeable} label={label}>
      {flat}
    </LiveMark>
  )
}

export function BotMark({ bot, dark, size = 36, ...motion }: { bot: unknown; dark: boolean; size?: number } & MotionProps) {
  const entry = bot as { id?: unknown; name?: unknown } | null | undefined
  const id = entry?.id
  const label = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : undefined
  return <Mark look={lookOf(bot)} dark={dark} size={size} seed={id === undefined || id === '' ? undefined : String(id)} label={label} {...motion} />
}

// Marks settle with a short hop when a run finishes, matching the desktop (mark.js useSettled):
// idle and an unread reply count as one so opening the chat does not cut the hop short,
// and leaving alert/failed does not celebrate.
function useSettled(state: string, id: string | undefined): boolean {
  const after = isAfterWorkState(state)
  const prev = useRef({ state, id })
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = { state, id }
    if (was.id !== id || !after) { setSettled(false); return undefined }
    if (!shouldCelebrateSettle(was.state, state)) return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), 1800)
    return () => clearTimeout(timer)
  }, [after, id])
  useEffect(() => { if (!after) prev.current = { state, id } })
  return settled
}

// Status badges per ui-standard section 8, scaled to the row's 44px avatar: a working
// green dot (12px), a waiting accent "?" (12px), the Main Bot star at 36% of the
// avatar within 14-22px like the desktop. Derived from the mark's state, one at a time
// (badge.ts / mark-states.js avatarBadge). `badge={false}` hides all badges (header pill
// and details panel). `ring` is the opaque color the badges are ringed in.
export function Avatar({ bot, dark, size = 44, ring, working = false, waiting = false, main = false, badge = true, state, live = false, pokeable = false }: {
  bot: Bot; dark: boolean; size?: number; ring: string; working?: boolean; waiting?: boolean; main?: boolean; badge?: boolean
} & MotionProps) {
  const star = Math.round(Math.min(22, Math.max(14, size * 0.36)))
  const dot = Math.round(size * 0.27)
  const doing = state ?? (waiting ? 'alert' : working ? 'working' : 'idle')
  const settled = useSettled(doing, bot?.id)
  const badgeKind = badgeOf({ state: doing, main, badge })
  return (
    <View style={{ width: size, height: size }}>
      <BotMark bot={bot} dark={dark} size={size} state={settled ? 'done' : doing} live={live} pokeable={pokeable} />
      {badgeKind === 'alert'
        ? <View style={[styles.badge, { width: dot + 4, height: dot + 4, borderRadius: (dot + 4) / 2, backgroundColor: ring, bottom: -2, right: -2 }]}>
            <View style={[styles.badgeIn, { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: '#4d6bfe' }]}>
              <Text style={[styles.q, { fontSize: dot * 0.66, lineHeight: dot }]}>?</Text>
            </View>
          </View>
        : badgeKind === 'working'
          ? <View style={[styles.badge, { width: dot + 4, height: dot + 4, borderRadius: (dot + 4) / 2, backgroundColor: ring, bottom: 0, right: 0 }]}>
              <View style={{ width: dot * 0.67, height: dot * 0.67, borderRadius: dot, backgroundColor: '#00c972', alignSelf: 'center', marginTop: dot * 0.165 }} />
            </View>
          : badgeKind === 'main'
            ? <View style={[styles.badge, { width: star + 3, height: star + 3, bottom: -2, right: -2, justifyContent: 'center', alignItems: 'center' }]}><MainStarIcon size={star} outline={ring} /></View>
            : null}
    </View>
  )
}

// A group avatar seats its members' characters like the desktop's RoomAvatar
// (mark.js clusterSeats). RN has no CSS mask, so the gaps between seats are faked
// with a ring in the background color.
function clusterSeats(count: number, frame: number): [number, number, number][] {
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

export function RoomAvatar({ room, bots, dark, size = 44, ring }: { room: Room; bots: Bot[]; dark: boolean; size?: number; ring: string }) {
  const [broken, setBroken] = useState('')
  const image = room.avatar?.image
  if (image && image !== broken) return <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: size / 2 }} onError={() => setBroken(image)} />
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const members = (room.members ?? []).map(id => byId.get(id)).filter((bot): bot is Bot => bot !== undefined)
  if (members.length === 0) {
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ring }} />
  }
  // Below ~32px a cluster reads as a crop; the members line up overlapped like
  // the desktop's bt-stack instead.
  if (size <= 32 && members.length > 1) {
    const overlap = size * 0.35
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {members.slice(0, 3).map((bot, index) => (
          <View key={bot.id} style={{ marginLeft: index === 0 ? 0 : -overlap, zIndex: members.length - index }}>
            <BotMark bot={bot} dark={dark} size={size} />
          </View>
        ))}
        {members.length > 3 ? <Text style={{ fontSize: Math.max(9, Math.round(size * 0.4)), color: "#888", marginLeft: -overlap * 0.4 }}>{`+${members.length - 3}`}</Text> : null}
      </View>
    )
  }
  const seats = clusterSeats(Math.min(members.length, 4), size)
  const overflow = members.length > 4 ? members.length - 3 : 0
  const gap = size / 14
  return (
    <View style={{ width: size, height: size }}>
      {seats.map(([x, y, s], index) => {
        const bot = members[index]
        if (overflow > 0 && index === 3) {
          return (
            <View key="more" style={[styles.seat, { left: x, top: y, width: s, height: s, borderRadius: s / 2, backgroundColor: ring }]}>
              <View style={{ flex: 1, borderRadius: s / 2, backgroundColor: ring, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: Math.max(8, Math.round(s * 0.36)), color: '#888' }}>{`+${overflow}`}</Text>
              </View>
            </View>
          )
        }
        return (
          <View key={bot?.id ?? index} style={[styles.seat, { left: x - gap / 2, top: y - gap / 2, width: s + gap, height: s + gap, borderRadius: (s + gap) / 2, backgroundColor: ring }]}>
            <View style={{ margin: gap / 2 }}><BotMark bot={bot} dark={dark} size={s} /></View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  badgeIn: { alignItems: 'center', justifyContent: 'center' },
  q: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  seat: { position: 'absolute', overflow: 'hidden' },
})
