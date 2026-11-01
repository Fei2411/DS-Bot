import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar } from '../ui/marks.tsx'
import type { ChatTarget } from './TeamList.tsx'

interface PendingRow { key: string; botId: string; roomId?: string; summary: string }

// Every pending question, approval and secret request, as one row each.
export function NeedsYou({ onOpen }: { onOpen: (target: ChatTarget) => void }) {
  const { team } = useTeam()
  const { p, dark } = useTheme()
  const bots = team?.bots ?? []
  const rooms = team?.rooms ?? []
  const botOfSession = (sessionId: string) => bots.find(b => b.sessionId === sessionId || b.id === sessionId)

  const rows: PendingRow[] = [
    ...Object.entries(team?.questions ?? {}).flatMap(([sessionId, question]) => {
      const bot = botOfSession(sessionId)
      return bot ? [{ key: `q-${question.id}`, botId: bot.id, summary: question.question }] : []
    }),
    ...(team?.work?.approvals ?? []).map(a => ({
      key: `a-${a.id}`, botId: a.botId, roomId: a.roomId,
      summary: [a.tool, a.reason].filter(Boolean).join(' · '),
    })),
    ...Object.entries(team?.secretRequests ?? {}).flatMap(([botId, list]) =>
      (list ?? []).filter(r => r.status !== 'settled').map(r => ({ key: `s-${r.id}`, botId, summary: r.name ? t('Asks for the secret {name}', { name: r.name }) : t('A secret is needed') }))),
  ]

  const look = (row: PendingRow) => {
    const room = row.roomId ? rooms.find(r => r.id === row.roomId) : undefined
    const bot = bots.find(b => b.id === row.botId)
    return { name: room?.name ?? bot?.name ?? '', bot }
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: p.main }}
      data={rows}
      keyExtractor={row => row.key}
      renderItem={({ item: row }) => {
        const { name, bot } = look(row)
        return (
          <Pressable accessibilityRole="button" onPress={() => onOpen(row.roomId ? { kind: 'room', id: row.roomId } : { kind: 'bot', id: row.botId })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
            {bot ? <Avatar bot={bot} dark={dark} size={44} ring={p.main} waiting /> : <View style={{ width: 44, height: 44 }} />}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 7, paddingHorizontal: 16 },
  body: { flex: 1, minWidth: 0 },
})
