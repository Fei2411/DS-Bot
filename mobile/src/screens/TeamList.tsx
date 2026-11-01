import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, SectionList } from 'react-native'
import type { Bot, Room } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { PinMarkIcon, SearchIcon } from '../ui/icons.tsx'
import { workPhrase } from '../ui/phrases.ts'

export interface ChatTarget { kind: 'bot' | 'room'; id: string }

// The team list shared by A's tab and B's drawer: the first Main Bot as the tile,
// then rows — pinned first, then createdAt desc (the phone state carries no
// session update time; host gap).
export function TeamList({ onOpen, largeTitle = false }: { onOpen: (target: ChatTarget) => void; largeTitle?: boolean }) {
  const { team, online, error } = useTeam()
  const { p, dark } = useTheme()
  const [query, setQuery] = useState('')

  const bots = team?.bots ?? []
  const mains = new Set(team?.mainBotIds ?? [])
  const main = bots.find(bot => bot.id === team?.mainBotId) ?? bots.find(bot => mains.has(bot.id))
  const workBots = team?.work?.bots ?? {}
  const workRooms = team?.work?.rooms ?? {}
  const waiting = team?.work?.waiting ?? {}
  const questions = team?.questions ?? {}
  const approvals = team?.work?.approvals ?? []

  const entries = useMemo(() => {
    const list = [
      ...bots.filter(bot => bot.id !== main?.id && (bot.hidden !== true || mains.has(bot.id))).map(bot => ({ kind: 'bot' as const, item: bot })),
      ...(team?.rooms ?? []).filter(room => room.hidden !== true).map(room => ({ kind: 'room' as const, item: room })),
    ]
    return list
      .filter(entry => query.trim() === '' || entry.item.name.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || (b.item.createdAt ?? 0) - (a.item.createdAt ?? 0))
  }, [bots, team?.rooms, main?.id, query])

  const preview = (bot: Bot): string | undefined => {
    const sessionId = bot.sessionId ?? bot.id
    if (questions[sessionId] !== undefined) return t('Waiting for your answer')
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
    return bot.role
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
      {largeTitle ? <Text style={[typeScale.largeTitle, { color: p.ink, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 }]}>{t('Team')}</Text> : null}
      <View style={[styles.search, { backgroundColor: p.hover }]}>
        <SearchIcon size={16} color={p.ink3} />
        <TextInput value={query} onChangeText={setQuery} placeholder={t('Search the team')} placeholderTextColor={p.ink3}
          style={[styles.searchInput, { color: p.ink }]} autoCapitalize="none" autoCorrect={false} />
      </View>
      {error ? <Text style={[typeScale.small, { color: p.danger, paddingHorizontal: 20, paddingBottom: 4 }]} accessibilityRole="alert">{error}</Text> : null}
      <SectionList
        sections={[{ data: entries }]}
        keyExtractor={entry => `${entry.kind}-${entry.item.id}`}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={() => main ? (
          <Pressable accessibilityRole="button" onPress={() => onOpen({ kind: 'bot', id: main.id })}
            style={({ pressed }) => [styles.tile, { backgroundColor: pressed ? p.active : p.card, borderColor: p.line }]}>
            <Avatar bot={main} dark={dark} size={60} ring={p.card} main working={workBots[main.id] !== undefined} waiting={questions[main.sessionId ?? main.id] !== undefined} />
            <View style={{ marginLeft: 14, flex: 1, minWidth: 0 }}>
              <Text style={[typeScale.headerTitle, { color: p.ink }]} numberOfLines={1}>{main.name}</Text>
              {main.role ? <Text style={[typeScale.small, { color: p.ink2, marginTop: 2 }]} numberOfLines={1}>{main.role}</Text> : null}
            </View>
          </Pressable>
        ) : <></>}
        renderItem={({ item: entry }) => entry.kind === 'bot' ? (
          <BotRow bot={entry.item} p={p} dark={dark} mains={mains} questions={questions} approvals={approvals} workBots={workBots} preview={preview(entry.item)} onPress={() => onOpen({ kind: 'bot', id: entry.item.id })} />
        ) : (
          <RoomRow room={entry.item} bots={bots} p={p} dark={dark} approvals={approvals} preview={roomPreview(entry.item)} working={(workRooms[entry.item.id] ?? []).length > 0} onPress={() => onOpen({ kind: 'room', id: entry.item.id })} />
        )}
        ListEmptyComponent={<Text style={[typeScale.small, { color: p.ink3, textAlign: 'center', marginTop: 40 }]}>{team === null ? t('Connecting…') : ''}</Text>}
      />
    </View>
  )
}

function BotRow({ bot, p, dark, mains, questions, approvals, workBots, preview, onPress }: {
  bot: Bot; p: ReturnType<typeof useTheme>['p']; dark: boolean; mains: Set<string>
  questions: Record<string, unknown>; approvals: { botId: string }[]; workBots: Record<string, unknown>; preview?: string; onPress: () => void
}) {
  const waiting = questions[bot.sessionId ?? bot.id] !== undefined || approvals.some(a => a.botId === bot.id)
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
      <Avatar bot={bot} dark={dark} size={44} ring={p.main} main={mains.has(bot.id)} working={workBots[bot.id] !== undefined} waiting={waiting} />
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={[typeScale.rowName, { color: p.ink, flexShrink: 1 }]} numberOfLines={1}>{bot.name}</Text>
          {bot.pinned === true ? <PinMarkIcon size={12} /> : null}
        </View>
        {preview ? <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{preview}</Text> : null}
      </View>
    </Pressable>
  )
}

function RoomRow({ room, bots, p, dark, approvals, preview, working, onPress }: {
  room: Room; bots: Bot[]; p: ReturnType<typeof useTheme>['p']; dark: boolean
  approvals: { roomId?: string }[]; preview?: string; working: boolean; onPress: () => void
}) {
  const waiting = approvals.some(a => a.roomId === room.id)
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
      <View>
        <RoomAvatar room={room} bots={bots} dark={dark} size={44} ring={p.main} />
        {waiting ? <View style={[styles.waitDot, { borderColor: p.main }]}>
          <View style={[styles.waitIn, { backgroundColor: p.accent }]}><Text style={{ color: '#fff', fontSize: 9, fontWeight: '600', textAlign: 'center', lineHeight: 11 }}>?</Text></View>
        </View> : working ? <View style={[styles.waitDot, { borderColor: p.main }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.green }} /></View> : null}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={[typeScale.rowName, { color: p.ink, flexShrink: 1 }]} numberOfLines={1}>{room.name}</Text>
          {room.pinned === true ? <PinMarkIcon size={12} /> : null}
        </View>
        {preview ? <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{preview}</Text> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 8, borderRadius: radius.input, paddingHorizontal: 10, height: 36 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
  tile: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 6, borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 7, paddingHorizontal: 16 },
  rowBody: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  waitDot: { position: 'absolute', bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  waitIn: { width: 12, height: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
})
