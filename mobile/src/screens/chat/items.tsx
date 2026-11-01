import { StyleSheet, Text, View } from 'react-native'
import { t, dateLocale } from '../../ui/i18n.ts'
import { radius, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Markdown } from './markdown.tsx'

export interface ChatItem {
  kind: 'bot' | 'user' | 'event' | 'answer' | 'view' | 'divider'
  text?: string
  time?: number
  seq?: number
  turn?: number
  role?: string
  name?: string
  botId?: string
  images?: number
  title?: string
  questions?: { question: string }[]
  answers?: { selected?: string[]; custom?: string }[]
}

export const itemKey = (item: ChatItem, index: number) => `${item.kind}-${item.seq ?? item.time ?? index}-${index}`

// One displayItems row (parts.js). Bubbles: radius 18, padding 7×12, Bot on the
// theme's bubble color, the user on user/userInk. `prefs.width` caps the Bot
// bubble at min(width%, 100% - 40); flat layout draws Bot text full width.
export function Item({ item, p, flat, maxWidth, inRoom }: { item: ChatItem; p: Palette; flat: boolean; maxWidth: number | string; inRoom: boolean }) {
  if (item.kind === 'divider') {
    return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 10 }]}>{typeof item.time === 'number' ? new Date(item.time).toLocaleDateString(dateLocale(), { month: 'long', day: 'numeric' }) : ''}</Text>
  }
  if (item.kind === 'event') {
    const label = { request: t('asked for work'), reply: t('replied'), report: t('reported back'), stopped: t('stopped') }[item.role ?? ''] ?? item.role ?? ''
    return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, textAlign: 'center' }]}>{t('{name} {event}', { name: item.name ?? t('a Bot'), event: label })}</Text>
  }
  if (item.kind === 'view') {
    return (
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{item.title ?? 'View'}</Text>
      </View>
    )
  }
  if (item.kind === 'answer') {
    const text = item.answers?.map(answer => [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])].join(', ')).join('\n') ?? item.text ?? ''
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth }]}>
        <Text selectable style={[type.bubble, { color: p.userInk }]}>{text}</Text>
      </View>
    )
  }
  if (item.kind === 'user') {
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth }]}>
        {item.text ? <Markdown text={item.text} p={p} textColor={p.userInk} /> : null}
        {item.images ? <Text style={[type.caption, { color: p.userInk, opacity: 0.8, marginTop: 4 }]}>{t('{count} images', { count: item.images })}</Text> : null}
      </View>
    )
  }
  const name = inRoom && item.name ? <Text style={[type.caption, { color: p.ink3, marginBottom: 2, marginLeft: 2 }]}>{item.name}</Text> : null
  if (flat) {
    return (
      <View style={{ alignSelf: 'flex-start', maxWidth, marginVertical: 4 }}>
        {name}
        <Markdown text={item.text ?? ''} p={p} textColor={p.ink} />
      </View>
    )
  }
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth }}>
      {name}
      <View style={[styles.bubble, { backgroundColor: p.bubble }]}>
        <Markdown text={item.text ?? ''} p={p} textColor={p.ink} />
      </View>
    </View>
  )
}

const type = typeScale
const styles = StyleSheet.create({
  bubble: { borderRadius: radius.bubble, paddingHorizontal: 12, paddingVertical: 7, marginVertical: 2 },
  userBubble: { alignSelf: 'flex-end' },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14 },
})
