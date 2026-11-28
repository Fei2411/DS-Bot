import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View, SectionList, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { Agent, Bot, Room } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { roomHasPending } from '../nav/pending.ts'
import { botMarkState, botPreviewKind, hasUnreadBotReply } from '../team/mark-state.ts'
import { isUnread, seenVersion, subscribeSeen } from '../team/seen.ts'
import { getLang, t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { MarksShown } from '../ui/avatar/LiveMark.tsx'
import { FishLogo, PinMarkIcon } from '../ui/icons.tsx'
import { roomTitle, workPhrase, type WorkDetail } from '../ui/phrases.ts'
import { teamListEmptyMessage } from '../nav/team-list-empty.ts'
import { cleanPreview } from './chat/settled.ts'

export interface ChatTarget { kind: 'bot' | 'room' | 'agent'; id: string; focus?: string }

// The drawer's team list, laid out like the desktop sidebar (sidebar.js): every Main
// Bot as a tile on top, then the other Bots and groups as rows, pinned first, then
// by their latest message.
export function TeamList({ onOpen, query = '', current }: { onOpen: (target: ChatTarget) => void; query?: string; current?: string }) {
  const { team, error, computer } = useTeam()
  const { p, dark } = useTheme()
  const hostId = computer?.hostDeviceId ?? ''
  useSyncExternalStore(subscribeSeen, seenVersion)
  // Marks move only in the rows in view, as the desktop's do (avatar/live.js); until the
  // list says which rows those are, all are.
  const shown = useContext(MarksShown)
  const [inView, setInView] = useState<ReadonlySet<string> | null>(null)
  const onViewable = useRef(({ viewableItems }: { viewableItems: { key: string }[] }) => setInView(new Set(viewableItems.map(token => token.key)))).current
  const viewability = useRef({ itemVisiblePercentThreshold: 1 }).current
  const headerHeight = useRef(0)
  const scrollY = useRef(0)
  const [headerInView, setHeaderInView] = useState(true)
  const syncHeaderInView = () => setHeaderInView(headerHeight.current <= 0 || scrollY.current < headerHeight.current)
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = event.nativeEvent.contentOffset.y
    syncHeaderInView()
  }

  const bots = Array.isArray(team?.bots) ? team.bots : []
  const mains = new Set(team?.mainBotIds ?? [])
  const needle = query.trim().toLowerCase()
  useEffect(() => {
    scrollY.current = 0
    setHeaderInView(true)
  }, [needle])
  const lang = getLang()
  const mainList = bots.filter(bot => mains.has(bot.id) && bot.hidden !== true && (needle === '' || (bot.name ?? '').toLowerCase().includes(needle)))
  const agentList = (Array.isArray(team?.agents) ? team.agents : []).filter(agent => needle === '' || agentName(agent).toLowerCase().includes(needle))
  const workRooms = team?.work?.rooms ?? {}
  const approvals = (Array.isArray(team?.work?.approvals) ? team.work.approvals : []).filter(a => a?.answerable !== false)

  const entries = useMemo(() => {
    const rooms = Array.isArray(team?.rooms) ? team.rooms : []
    const list = [
      ...bots.filter(bot => !mains.has(bot.id) && bot.hidden !== true).map(bot => ({ kind: 'bot' as const, item: bot })),
      ...rooms.filter(room => room.hidden !== true).map(room => ({ kind: 'room' as const, item: room })),
    ]
    return list
      .filter(entry => needle === '' || (entry.item.name ?? '').toLowerCase().includes(needle) ||
        (entry.kind === 'room' && roomTitle(entry.item).toLowerCase().includes(needle)))
      .sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || (b.item.lastAt ?? b.item.createdAt ?? 0) - (a.item.lastAt ?? a.item.createdAt ?? 0))
  }, [bots, team?.rooms, team?.mainBotIds, needle, lang])

  const emptyMessage = teamListEmptyMessage(team !== null, needle, mainList.length + agentList.length + entries.length)

  const preview = (bot: Bot): string | undefined => {
    const line = botPreviewKind(team, bot)
    if (line.kind === 'answer') return t('Waiting for your answer')
    if (line.kind === 'approval') return t('Waiting for your approval')
    if (line.kind === 'doing') return `${workPhrase(line.doing as WorkDetail | string | undefined)}…`
    if (line.kind === 'group' && line.groupEntry !== undefined) {
      const room = team?.rooms?.find(r => r.id === line.roomId)
      return `${room !== undefined ? roomTitle(room) : t('a group chat')} · ${workPhrase(line.groupEntry)}…`
    }
    if (line.kind === 'waiting') return t('Waiting for your answer')
    return cleanPreview(bot.preview) ?? bot.role
  }
  const roomPreview = (room: Room): string | undefined => {
    if (approvals.some(a => a?.roomId === room.id)) return t('Waiting for your approval')
    const members = Array.isArray(workRooms[room.id]) ? workRooms[room.id] : []
    if (members.length > 0) {
      const name = bots.find(b => b.id === members[0]?.botId)?.name ?? ''
      return `${name} · ${workPhrase(members[0])}…${members.length > 1 ? ` +${members.length - 1}` : ''}`
    }
    return room.preview
  }

  return (
    <View style={styles.root}>
      {error ? <Text style={[typeScale.small, { color: p.danger, paddingHorizontal: 20, paddingBottom: 4 }]} accessibilityRole="alert">{error}</Text> : null}
      <SectionList
        sections={entries.length > 0 ? [{ data: entries }] : []}
        keyExtractor={entry => `${entry.kind}-${entry.item.id}`}
        stickySectionHeadersEnabled={false}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewability}
        onScroll={onScroll}
        scrollEventThrottle={100}
        ListHeaderComponent={mainList.length > 0 || agentList.length > 0 ? (
          <View onLayout={event => { headerHeight.current = event.nativeEvent.layout.height; syncHeaderInView() }}>
          {mainList.length > 0 ? <MarksShown.Provider value={shown && headerInView}><View style={styles.tiles}>
            {mainList.map(main => {
              const replied = hasUnreadBotReply(main, isUnread(hostId, main.id, main.lastBotAt, current === main.id))
              return (
                <Pressable key={main.id} accessibilityRole="button" accessibilityLabel={`${main.name}, ${t('Main Bot')}`} onPress={() => onOpen({ kind: 'bot', id: main.id })}
                  style={({ pressed }) => [styles.tile, { backgroundColor: pressed || current === main.id ? p.active : p.hover }]}>
                  <Avatar bot={main} dark={dark} size={52} ring={p.sidebar} main state={botMarkState(team, main, { replied })} live />
                  <Text style={[typeScale.small, { color: p.ink, fontWeight: '600', marginTop: 6 }]} numberOfLines={1}>{main.name}</Text>
                  {main.role ? <View style={[styles.tag, { backgroundColor: p.active }]}><Text style={{ fontSize: 11, lineHeight: 15, color: p.ink2 }} numberOfLines={1}>{main.role}</Text></View> : null}
                </Pressable>
              )
            })}
          </View></MarksShown.Provider> : null}
          {agentList.map(agent => <AgentRow key={agent.id} agent={agent} p={p} selected={current === agent.id} onPress={() => onOpen({ kind: 'agent', id: agent.id })} />)}
          </View>
        ) : undefined}
        renderItem={({ item: entry }) => {
          if (entry.kind === 'bot') {
            const unread = isUnread(hostId, entry.item.id, entry.item.lastAt, current === entry.item.id)
            const replied = hasUnreadBotReply(entry.item, isUnread(hostId, entry.item.id, entry.item.lastBotAt, current === entry.item.id))
            return <BotRow bot={entry.item} p={p} dark={dark} mains={mains} state={botMarkState(team, entry.item, { replied })} shown={shown && (inView === null || inView.has(`bot-${entry.item.id}`))} preview={preview(entry.item)} selected={current === entry.item.id} unread={unread} onPress={() => onOpen({ kind: 'bot', id: entry.item.id })} />
          }
          return <RoomRow room={entry.item} bots={bots} p={p} dark={dark} waiting={roomHasPending(team, entry.item)} preview={roomPreview(entry.item)} selected={current === entry.item.id} unread={isUnread(hostId, entry.item.id, entry.item.lastAt, current === entry.item.id)} working={(workRooms[entry.item.id] ?? []).length > 0} onPress={() => onOpen({ kind: 'room', id: entry.item.id })} />
        }}
        ListEmptyComponent={emptyMessage === null ? undefined : (
          <Text style={[typeScale.small, { color: p.ink3, textAlign: 'center', marginTop: 40 }]} accessibilityLiveRegion="polite">{emptyMessage}</Text>
        )}
      />
    </View>
  )
}

function BotRow({ bot, p, dark, mains, state, shown, preview, unread, selected, onPress }: {
  bot: Bot; p: ReturnType<typeof useTheme>['p']; dark: boolean; mains: Set<string>
  state: string; shown: boolean; preview?: string; unread?: boolean; selected?: boolean; onPress: () => void
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: p.hover }]}>
      <MarksShown.Provider value={shown}>
        <Avatar bot={bot} dark={dark} size={36} ring={p.sidebar} main={mains.has(bot.id)} state={state} live />
      </MarksShown.Provider>
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

export const agentName = (agent: Agent) => agent.name ?? 'DSH Agent'

// The DSH Agent's row: DSH's own mark, as the desktop sidebar shows it.
function AgentRow({ agent, p, selected, onPress }: { agent: Agent; p: ReturnType<typeof useTheme>['p']; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, (pressed || selected) && { backgroundColor: p.hover }]}>
      <View style={[styles.agentMark, { backgroundColor: p.hover }]}><FishLogo size={22} /></View>
      <View style={styles.rowBody}>
        <Text style={[typeScale.rowName, { color: p.ink }]} numberOfLines={1}>{agentName(agent)}</Text>
      </View>
    </Pressable>
  )
}

function RoomRow({ room, bots, p, dark, waiting, preview, unread, working, selected, onPress }: {
  room: Room; bots: Bot[]; p: ReturnType<typeof useTheme>['p']; dark: boolean
  waiting: boolean; preview?: string; unread?: boolean; working: boolean; selected?: boolean; onPress: () => void
}) {
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
          <Text style={[typeScale.rowName, { color: p.ink, flexShrink: 1 }]} numberOfLines={1}>{roomTitle(room)}</Text>
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
  tile: { width: 104, alignItems: 'center', borderRadius: radius.card, paddingTop: 10, paddingBottom: 8, paddingHorizontal: 6 },
  tag: { marginTop: 3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 6, paddingHorizontal: 10, marginHorizontal: 8, borderRadius: 10 },
  rowBody: { flex: 1, minWidth: 0 },
  agentMark: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  waitDot: { position: 'absolute', bottom: -2, right: -2, width: 18, height: 18, borderRadius: 9, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  waitIn: { width: 12, height: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
})
