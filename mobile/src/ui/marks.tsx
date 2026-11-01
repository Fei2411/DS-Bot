import { Image, StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { characterMarkup, lookOf, MASK_ID, shapeOf } from '../../../ds-bot/src/client/characters.js'
import { INKS } from '../../../ds-bot/src/client/inks.js'
import type { Bot, Room } from '../connection.ts'
import { MainStarIcon } from './icons.tsx'

// The Bot's own mascot, drawn by the same generator as the desktop mark
// (ds-bot/src/client/characters.js). CSS ink variables resolve to the mode's color.

let serial = 0

export function botSvg(bot: unknown, dark: boolean): string {
  const look = lookOf(bot)
  const box = shapeOf(look.shape).size
  const id = `pm${serial += 1}`
  const inner = characterMarkup(look.shape, look.color).replaceAll(MASK_ID, id)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${inner}</svg>`
  const inks = INKS as Record<string, string[]>
  return svg.replace(/var\(--bt-ink-(\w+)\)/g, (_match, name: string) => (inks[name] ?? inks.gray)[dark ? 1 : 0])
}

export function BotMark({ bot, dark, size = 36 }: { bot: unknown; dark: boolean; size?: number }) {
  const look = lookOf(bot)
  if (typeof look.image === 'string' && look.image.startsWith('data:')) {
    return <Image source={{ uri: look.image }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  }
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={botSvg(bot, dark)} width={size} height={size} />
    </View>
  )
}

// Status badges per ui-standard 8.2, scaled to the row's 44px avatar: a working
// green dot (12px), a waiting accent "?" (12px), the Main Bot star at 36% of the
// avatar, each ringed in the list's background color.
export function Avatar({ bot, dark, size = 44, ring, working = false, waiting = false, main = false }: {
  bot: Bot; dark: boolean; size?: number; ring: string; working?: boolean; waiting?: boolean; main?: boolean
}) {
  const star = Math.round(size * 0.36)
  const dot = Math.round(size * 0.27)
  return (
    <View style={{ width: size, height: size }}>
      <BotMark bot={bot} dark={dark} size={size} />
      {waiting
        ? <View style={[styles.badge, { width: dot + 4, height: dot + 4, borderRadius: (dot + 4) / 2, backgroundColor: ring, bottom: -2, right: -2 }]}>
            <View style={[styles.badgeIn, { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: '#4d6bfe' }]}>
              <Text style={[styles.q, { fontSize: dot * 0.66, lineHeight: dot }]}>?</Text>
            </View>
          </View>
        : working
          ? <View style={[styles.badge, { width: dot + 4, height: dot + 4, borderRadius: (dot + 4) / 2, backgroundColor: ring, bottom: 0, right: 0 }]}>
              <View style={{ width: dot * 0.67, height: dot * 0.67, borderRadius: dot, backgroundColor: '#00c972', alignSelf: 'center', marginTop: dot * 0.165 }} />
            </View>
          : null}
      {main ? <View style={[styles.badge, { width: star + 3, height: star + 3, bottom: -2, right: -2, justifyContent: 'center', alignItems: 'center' }]}><MainStarIcon size={star} /></View> : null}
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
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const members = (room.members ?? []).map(id => byId.get(id)).filter((bot): bot is Bot => bot !== undefined)
  if (members.length === 0) {
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ring }} />
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
