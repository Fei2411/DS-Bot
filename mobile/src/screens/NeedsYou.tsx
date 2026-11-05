import { SectionList, StyleSheet, Text, View, Pressable } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { type as typeScale, useTheme, radius } from '../ui/tokens.ts'
import { Avatar } from '../ui/marks.tsx'
import type { ChatTarget } from './TeamList.tsx'

interface PendingRow { key: string; botId: string; roomId?: string; summary: string }
interface Section { title: string; mark: string; data: PendingRow[] }

// Pending things grouped the way the desktop groups them: questions, approvals,
// secret requests and cards each get a section with its own badge.
export function NeedsYou({ onOpen }: { onOpen: (target: ChatTarget) => void }) {
  const { team } = useTeam()
  const { p, dark } = useTheme()
  const bots = team?.bots ?? []
  const rooms = team?.rooms ?? []
  const botOfSession = (sessionId: string) => bots.find(b => b.sessionId === sessionId || b.id === sessionId)

  const questions = Object.entries(team?.questions ?? {}).flatMap(([sessionId, question]) => {
    const bot = botOfSession(sessionId)
    return bot ? [{ key: `q-${question.id}`, botId: bot.id, summary: question.question }] : []
  })
  const approvals = (team?.work?.approvals ?? []).map(a => ({
    key: `a-${a.id}`, botId: a.botId, roomId: a.roomId,
    summary: [a.tool, a.reason].filter(Boolean).join(' · '),
  }))
  const secrets = Object.entries(team?.secretRequests ?? {}).flatMap(([botId, list]) =>
    (list ?? []).filter(r => r.status === 'pending').map(r => ({ key: `s-${r.id}`, botId, summary: r.name ? t('Asks for the secret {name}', { name: r.name }) : t('A secret is needed') })))
  const handoffs = Object.entries((team as { browserHolds?: Record<string, { callId?: string; note?: string; reason?: string }> } | null)?.browserHolds ?? {})
    .filter(([, hold]) => hold.callId !== undefined)
    .map(([botId, hold]) => ({ key: `h-${hold.callId}`, botId, summary: hold.note ?? hold.reason ?? t('Browser handoff') }))
  const views = Object.entries(team?.views ?? {}).flatMap(([sessionId, view]) => {
    const bot = botOfSession(sessionId)
    return bot ? [{ key: `v-${view?.id ?? sessionId}`, botId: bot.id, summary: view?.title ?? 'View' }] : []
  })

  const sections: Section[] = [
    { title: t('Questions'), mark: '?', data: questions },
    { title: t('Approvals'), mark: '!', data: approvals },
    { title: t('Secret requests'), mark: '🔑', data: secrets },
    { title: t('Browser handoffs'), mark: '🌐', data: handoffs },
    { title: t('Cards'), mark: '▣', data: views },
  ].filter(section => section.data.length > 0)

  const look = (row: PendingRow) => {
    const room = row.roomId ? rooms.find(r => r.id === row.roomId) : undefined
    const bot = bots.find(b => b.id === row.botId)
    return { name: room?.name ?? bot?.name ?? '', bot }
  }

  return (
    <SectionList
      style={{ flex: 1, backgroundColor: p.main }}
      sections={sections}
      keyExtractor={row => row.key}
      renderSectionHeader={({ section }) => (
        <View style={[styles.header, { backgroundColor: p.main }]}>
          <View style={[styles.badge, { backgroundColor: p.hover }]}>
            <Text style={[typeScale.caption, { color: p.ink2 }]}>{section.mark}</Text>
          </View>
          <Text style={[typeScale.caption, { color: p.ink3, fontWeight: '600' }]}>{section.title}</Text>
        </View>
      )}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  badge: { width: 20, height: 20, borderRadius: radius.tag, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 7, paddingHorizontal: 16 },
  body: { flex: 1, minWidth: 0 },
})
