import { useEffect } from 'react'
import { SectionList, StyleSheet, Text, View, Pressable } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { chatTargetOf, pendingItemsOf, type PendingItem } from '../nav/pending.ts'
import { INBOX_SECTIONS } from '../../../ds-bot/src/client/inbox-text.js'
import { t } from '../ui/i18n.ts'
import { roomTitle } from '../ui/phrases.ts'
import { type as typeScale, useTheme, radius } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import type { ChatTarget } from './TeamList.tsx'

interface Section { title: string; count: number; data: PendingItem[] }

// What waits for the user, in the computer's three groups: your call, needs a fix,
// suggestions. Each row opens the chat it waits in; a group's card opens the group.
export function NeedsYou({ onOpen }: { onOpen: (target: ChatTarget) => void }) {
  const { team, refresh } = useTeam()
  const { p, dark } = useTheme()
  useEffect(() => { refresh?.() }, [refresh])
  const bots = team?.bots ?? []
  const rooms = team?.rooms ?? []
  const items = pendingItemsOf(team)

  const sections: Section[] = INBOX_SECTIONS
    .map(([group, title]) => {
      const data = items.filter(item => item.group === group)
      return { title: t(title), count: data.length, data }
    })
    .filter(section => section.data.length > 0)

  const look = (row: PendingItem) => {
    const room = row.roomId ? rooms.find(r => r.id === row.roomId) : undefined
    const bot = row.botId ? bots.find(b => b.id === row.botId) : undefined
    const groupName = room ? roomTitle(room) : undefined
    return { name: [bot?.name, groupName].filter(Boolean).join(' · '), bot, room }
  }
  const target = (row: PendingItem): ChatTarget | null => chatTargetOf(row)

  return (
    <SectionList
      style={{ flex: 1, backgroundColor: p.main }}
      sections={sections}
      keyExtractor={row => row.key}
      renderSectionHeader={({ section }) => (
        <View style={[styles.header, { backgroundColor: p.main }]}>
          <Text style={[typeScale.caption, { color: p.ink2, fontWeight: '600' }]}>{section.title}</Text>
          <View style={[styles.badge, { backgroundColor: p.hover }]}>
            <Text style={[typeScale.caption, { color: p.ink3 }]}>{section.count}</Text>
          </View>
        </View>
      )}
      renderItem={({ item: row }) => {
        const { name, bot, room } = look(row)
        const to = target(row)
        const showBot = bot && !(row.kind === 'room-paused' || row.kind === 'goal')
        return (
          <Pressable accessibilityRole="button" disabled={to === null} onPress={() => { if (to !== null) onOpen(to) }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
            {showBot ? <Avatar bot={bot} dark={dark} size={44} ring={p.main} waiting />
              : room ? <RoomAvatar room={room} bots={bots} dark={dark} size={44} ring={p.main} />
                : <View style={{ width: 44, height: 44 }} />}
            <View style={styles.body}>
              <Text style={[typeScale.rowName, { color: p.ink }]} numberOfLines={1}>{name}</Text>
              <Text style={[typeScale.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{row.summary}</Text>
            </View>
          </Pressable>
        )
      }}
      ListEmptyComponent={<Text style={[typeScale.small, { color: p.ink3, textAlign: 'center', marginTop: 60 }]}>{t('Nothing needs you')}</Text>}
    />
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: radius.tag, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 7, paddingHorizontal: 16 },
  body: { flex: 1, minWidth: 0 },
})
