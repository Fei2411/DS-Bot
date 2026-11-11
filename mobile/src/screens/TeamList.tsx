import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View, SectionList } from 'react-native'
import type { Bot, Room } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { seenAt } from '../team/seen.ts'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { PinMarkIcon } from '../ui/icons.tsx'
import { workPhrase } from '../ui/phrases.ts'

export interface ChatTarget { kind: 'bot' | 'room'; id: string }

// The drawer's team list, laid out like the desktop sidebar (sidebar.js): every Main
// Bot as a tile on top, then the other Bots and groups as rows, pinned first, then
// by their latest message.
export function TeamList({ onOpen, query = '', current }: { onOpen: (target: ChatTarget) => void; query?: string; current?: string }) {
  const { team, error } = useTeam()
  const { p, dark } = useTheme()

  const bots = team?.bots ?? []
  const mains = new Set(team?.mainBotIds ?? [])
  const mainList = bots.filter(bot => mains.has(bot.id) && bot.hidden !== true && (query.trim() === '' || bot.name.toLowerCase().includes(query.trim().toLowerCase())))
  const workBots = team?.work?.bots ?? {}
  const workRooms = team?.work?.rooms ?? {}
  const waiting = team?.work?.waiting ?? {}
  const questions = team?.questions ?? {}
  const approvals = team?.work?.approvals ?? []

  const entries = useMemo(() => {
    const list = [
      ...bots.filter(bot => !mains.has(bot.id) && bot.hidden !== true).map(bot => ({ kind: 'bot' as const, item: bot })),
      ...(team?.rooms ?? []).filter(room => room.hidden !== true).map(room => ({ kind: 'room' as const, item: room })),
    ]
    return list
      .filter(entry => query.trim() === '' || entry.item.name.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || (b.item.lastAt ?? b.item.createdAt ?? 0) - (a.item.lastAt ?? a.item.createdAt ?? 0))
  }, [bots, team?.rooms, team?.mainBotIds, query])

  const preview = (bot: Bot): string | undefined => {
    const sessionId = bot.sessionId ?? bot.id
    if (questions[sessionId] !== undefined || team?.views?.[sessionId] !== undefined) return t('Waiting for your answer')
    if (approvals.some(a => a.botId === bot.id)) return t('Waiting for your approval')
    const doing = workBots[bot.id] ?? team?.activity?.[bot.id]
    if (doing !== undefined) return `${workPhrase(doing)}…`
    const groupWork = Object.entries(workRooms).find(([, list]) => list.some(e => e.botId === bot.id))
    if (groupWork) {
      const room = team?.rooms?.find(r => r.id === groupWork[0])
      return `${room?.name ?? t('a group chat')} · ${workPhrase(groupWork[1].find(e => e.botId === bot.id)!)}…`
    }
    const waits = waiting[bot.id]
    if (waits !== undefined && (waits.bots?.length || waits.rooms?.length)) return t('Waiting for your answer')
    return bot.preview ?? bot.role
  }
  const roomPreview = (room: Room): string | undefined => {
    if (approvals.some(a => a.roomId === room.id)) return t('Waiting for your approval')
    const members = workRooms[room.id] ?? []
    if (members.length > 0) {
      const name = bots.find(b => b.id === members[0].botId)?.name ?? ''
      return `${name} · ${workPhrase(members[0])}…${members.length > 1 ? ` +${members.length - 1}` : ''}`
    }
    return room.preview
  }

  return (
    <View style={styles.root}>
      {error ? <Text style={[typeScale.small, { color: p.danger, paddingHorizontal: 20, paddingBottom: 4 }]} accessibilityRole="alert">{error}</Text> : null}
      <SectionList
        sections={[{ data: entries }]}
        keyExtractor={entry => `${entry.kind}-${entry.item.id}`}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={mainList.length > 0 ? (
          <View style={styles.tiles}>
            {mainList.map(main => (
              <Pressable key={main.id} accessibilityRole="button" accessibilityLabel={`${main.name}, ${t('Main Bot')}`} onPress={() => onOpen({ kind: 'bot', id: main.id })}
                style={({ pressed }) => [styles.tile, { backgroundColor: pressed || current === main.id ? p.active : p.hover }]}>
                <Avatar bot={main} dark={dark} size={52} ring={p.hover} main working={workBots[main.id] !== undefined} waiting={questions[main.sessionId ?? main.id] !== undefined} />
                <Text style={[typeScale.small, { color: p.ink, fontWeight: '600', marginTop: 6 }]} numberOfLines={1}>{main.name}</Text>
                {main.role ? <View style={[styles.tag, { backgroundColor: p.active }]}><Text style={{ fontSize: 11, lineHeight: 14, color: p.ink2 }} numberOfLines={1}>{main.role}</Text></View> : null}
              </Pressable>
            ))}
          </View>
        ) : undefined}
        renderItem={({ item: entry }) => entry.kind === 'bot' ? (
          <BotRow bot={entry.item} p={p} dark={dark} mains={mains} questions={questions} approvals={approvals} workBots={workBots} preview={preview(entry.item)} selected={current === entry.item.id} unread={entry.item.lastAt !== undefined && entry.item.lastAt > seenAt(entry.item.id)} onPress={() => onOpen({ kind: 'bot', id: entry.item.id })} />
        ) : (
          <RoomRow room={entry.item} bots={bots} p={p} dark={dark} approvals={approvals} preview={roomPreview(entry.item)} selected={current === entry.item.id} unread={entry.item.lastAt !== undefined && entry.item.lastAt > seenAt(entry.item.id)} working={(workRooms[entry.item.id] ?? []).length > 0} onPress={() => onOpen({ kind: 'room', id: entry.item.id })} />
        )}
        ListEmptyComponent={<Text style={[typeScale.small, { color: p.ink3, textAlign: 'center', marginTop: 40 }]}>{team === null ? t('Connecting…') : ''}</Text>}
      />
    </View>
  )
}

function BotRow({ bot, p, dark, mains, questions, approvals, workBots, preview, unread, selected, onPress }: {
  bot: Bot; p: ReturnType<typeof useTheme>['p']; dark: boolean; mains: Set<string>
  questions: Record<string, unknown>; approvals: { botId: string }[]; workBots: Record<string, unknown>; preview?: string; unread?: boolean; selected?: boolean; onPress: () => void
}) {
  const waiting = questions[bot.sessionId ?? bot.id] !== undefined || approvals.some(a => a.botId === bot.id)
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: p.hover }]}>
      <Avatar bot={bot} dark={dark} size={36} ring={p.sidebar} main={mains.has(bot.id)} working={workBots[bot.id] !== undefined} waiting={waiting} />
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={[typeScale.rowName, { color: p.ink, flexShrink: 1 }]} numberOfLines={1}>{bot.name}</Text>
          {bot.pinned === true ? <PinMarkIcon size={12} /> : null}
          {unread === true ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent, marginLeft: 'auto' }} /> : null}
        </View>
        {preview ? <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{preview}</Text> : null}
      </View>
    </Pressable>
  )
}

function RoomRow({ room, bots, p, dark, approvals, preview, unread, working, selected, onPress }: {
  room: Room; bots: Bot[]; p: ReturnType<typeof useTheme>['p']; dark: boolean
  approvals: { roomId?: string }[]; preview?: string; unread?: boolean; working: boolean; selected?: boolean; onPress: () => void
}) {
  const waiting = approvals.some(a => a.roomId === room.id)
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: p.hover }]}>
      <View>
        <RoomAvatar room={room} bots={bots} dark={dark} size={36} ring={p.sidebar} />
        {waiting ? <View style={[styles.waitDot, { borderColor: p.main }]}>
          <View style={[styles.waitIn, { backgroundColor: p.accent }]}><Text style={{ color: '#fff', fontSize: 9, fontWeight: '600', textAlign: 'center', lineHeight: 11 }}>?</Text></View>
        </View> : working ? <View style={[styles.waitDot, { borderColor: p.main }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.green }} /></View> : null}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={[typeScale.rowName, { color: p.ink, flexShrink: 1 }]} numberOfLines={1}>{room.name}</Text>
          {room.pinned === true ? <PinMarkIcon size={12} /> : null}
          {unread === true ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent, marginLeft: 'auto' }} /> : null}
        </View>
        {preview ? <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{preview}</Text> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10 },
  tile: { width: 100, alignItems: 'center', borderRadius: radius.card, paddingTop: 10, paddingBottom: 8, paddingHorizontal: 6 },
  tag: { marginTop: 3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6, paddingHorizontal: 10, marginHorizontal: 8, borderRadius: 10 },
  rowBody: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  waitDot: { position: 'absolute', bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  waitIn: { width: 12, height: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
})
