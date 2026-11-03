import { useEffect, useState } from 'react'
import { ActivityIndicator, Dimensions, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { t, dateLocale } from '../../ui/i18n.ts'
import { radius, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Markdown, hasBlockContent } from './markdown.tsx'
import { useTeam } from '../../team/context.tsx'
import { ViewCard } from './view.tsx'
import { viewAnswerText } from 'deep-view/core'

export interface ImageRef { attachmentId: string; mime?: string; name?: string }

export interface ChatItem {
  kind: 'bot' | 'user' | 'event' | 'answer' | 'view' | 'divider' | 'steps'
  text?: string
  time?: number
  seq?: number
  turn?: number
  role?: string
  name?: string
  botId?: string
  images?: number
  imageRefs?: ImageRef[]
  files?: { name: string; bytes?: number; attachmentId?: string }[]
  file?: string
  length?: number
  title?: string
  view?: { id?: string; title?: string; children?: unknown[]; blueprint?: { id?: string; title?: string; children?: unknown[] } }
  views?: { id: string; title: string; view: { id?: string; title?: string; children?: unknown[] } }[]
  questions?: { question: string }[]
  answers?: { id?: string; action?: string; values?: { selected?: string[]; inputs?: Record<string, unknown>; fields?: Record<string, string>; confirmed?: boolean }; selected?: string[]; custom?: string }[]
  tools?: { name: string; label?: string | null; ok?: boolean }[]
  ms?: number
  live?: boolean
  texts?: string[]
}

export const itemKey = (item: ChatItem, index: number) => `${item.kind}-${item.seq ?? item.time ?? index}-${index}`

// Session data URIs, kept only in memory so nothing touches disk.
const imageCache = new Map<string, string>()

// One displayItems row (parts.js). Bubbles: radius 18, padding 7×12, Bot on the
// theme's bubble color, the user on user/userInk. `prefs.width` caps the Bot
// bubble at min(width%, 100% - 40); flat layout draws Bot text full width.
export function Item({ item, p, flat, maxWidth, inRoom, sessionId, open, onToggle, onLongPress, onOpenFile }: { item: ChatItem; p: Palette; flat: boolean; maxWidth: number | string; inRoom: boolean; sessionId?: string; open?: boolean; onToggle?: () => void; onLongPress?: (text: string) => void; onOpenFile?: (file: { name: string; attachmentId?: string }) => void }) {
  const chips = (item.files ?? []).map(file => (
    <Pressable key={file.attachmentId ?? file.name} accessibilityRole="button" onPress={() => onOpenFile?.(file)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14, borderWidth: 1, borderColor: p.line, backgroundColor: p.card }}>
      <View style={{ flex: 1 }}>
        <Text style={[type.small, { color: p.ink, fontWeight: '500' }]} numberOfLines={1}>{file.name}</Text>
        <Text style={[type.caption, { color: p.ink3 }]}>{[(file.name.split('.').pop() ?? '').toUpperCase(), file.bytes !== undefined ? `${Math.max(1, Math.round(file.bytes / 1024))} KB` : ''].filter(Boolean).join(' · ')}</Text>
      </View>
    </Pressable>
  ))
  const source = item.answers !== undefined
    ? item.answers.map(answer => [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])].join(', ')).join('\n')
    : item.text ?? ''
  const longPress = () => { void Haptics.selectionAsync(); onLongPress?.(source) }
  if (item.kind === 'steps') return <Steps item={item} p={p} open={open === true} onToggle={onToggle ?? (() => {})} />
  if (item.kind === 'divider') {
    return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 10 }]}>{typeof item.time === 'number' ? new Date(item.time).toLocaleDateString(dateLocale(), { month: 'long', day: 'numeric' }) : ''}</Text>
  }
  if (item.kind === 'event') {
    if (item.role === 'paused') return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, textAlign: 'center' }]}>{t('Paused after {count} Bot relays. Waiting: {names}', { count: item.ms ?? 0, names: item.text ?? '' })}</Text>
    const label = { request: t('asked for work'), reply: t('replied'), report: t('reported back'), stopped: t('stopped') }[item.role ?? ''] ?? item.role ?? ''
    return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, textAlign: 'center' }]}>{t('{name} {event}', { name: item.name ?? t('a Bot'), event: label })}</Text>
  }
  if (item.kind === 'view') {
    return item.view !== undefined
      ? <ViewCard sessionId={sessionId ?? ''} view={item.view} p={p} readOnly />
      : <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
          <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{item.title ?? 'View'}</Text>
        </View>
  }
  if (item.kind === 'answer') {
    const viewReplies = (item.views ?? []).map((entry, i) => {
      const answer = (item.answers ?? []).find(a => a.id === entry.id) ?? item.answers?.[i]
      const detail = answer !== undefined && entry.view !== undefined ? viewAnswerText(entry.view, answer as never) : ''
      return { title: entry.title, detail }
    })
    if (viewReplies.length > 0) return (
      <Pressable onLongPress={longPress} style={[styles.answeredCard, { backgroundColor: p.card, borderColor: p.line, maxWidth }]}>
        {viewReplies.map((reply, i) => (
          <View key={i} style={{ gap: 4 }}>
            <Text style={[type.caption, { color: p.ink3 }]}>{reply.title}</Text>
            <Text style={[type.bubble, { color: p.ink }]}>{reply.detail !== '' ? reply.detail : source}</Text>
          </View>
        ))}
      </Pressable>
    )
    return (
      <Pressable onLongPress={longPress} style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth }]}>
        <Text style={[type.bubble, { color: p.userInk }]}>{source}</Text>
      </Pressable>
    )
  }
  if (item.kind === 'user') {
    return (
      <Pressable onLongPress={longPress} style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth }]}>
        {item.text ? <Markdown text={item.text} p={p} textColor={p.userInk} /> : null}
        {item.imageRefs !== undefined && item.imageRefs.length > 0 && sessionId !== undefined
          ? <ImageGrid refs={item.imageRefs} sessionId={sessionId} p={p} />
          : item.images ? <Text style={[type.caption, { color: p.userInk, opacity: 0.8, marginTop: 4 }]}>{t('{count} images', { count: item.images })}</Text> : null}
      </Pressable>
    )
  }
  const name = inRoom && item.name ? <Text style={[type.caption, { color: p.ink3, marginBottom: 2, marginLeft: 2 }]}>{item.name}</Text> : null
  const wide = hasBlockContent(item.text ?? '') || (item.imageRefs !== undefined && item.imageRefs.length > 0)
  if (flat) {
    return (
      <Pressable onLongPress={longPress} style={{ alignSelf: 'flex-start', maxWidth, width: wide ? '100%' : undefined, marginVertical: 4 }}>
        {name}
        <Markdown text={item.text ?? ''} p={p} textColor={p.ink} />
        {item.imageRefs !== undefined && item.imageRefs.length > 0 && sessionId !== undefined ? <ImageGrid refs={item.imageRefs} sessionId={sessionId} p={p} /> : null}
      </Pressable>
    )
  }
  return (
    <Pressable onLongPress={longPress} style={{ alignSelf: 'flex-start', maxWidth, width: wide ? '100%' : undefined }}>
      {name}
      <View style={[styles.bubble, { backgroundColor: p.bubble }]}>
        <Markdown text={item.text ?? ''} p={p} textColor={p.ink} />
        {item.imageRefs !== undefined && item.imageRefs.length > 0 && sessionId !== undefined ? <ImageGrid refs={item.imageRefs} sessionId={sessionId} p={p} /> : null}
      </View>
    </Pressable>
  )
}

const type = typeScale

// The photo grid inside a bubble: two columns of ~120px squares fetched once per
// attachment. A failed tile says why and points at the computer.
function ImageGrid({ refs, sessionId, p }: { refs: ImageRef[]; sessionId: string; p: Palette }) {
  const [viewing, setViewing] = useState(-1)
  const states = useImages(sessionId, refs)
  const width = Dimensions.get('window').width
  const gap = 6
  return (
    <View style={{ marginTop: 6 }}>
      <View style={[styles.grid, { gap }]}>
        {refs.map((ref, index) => {
          const state = states[index]
          return (
            <Pressable key={ref.attachmentId} accessibilityRole="imagebutton" accessibilityLabel={ref.name ?? t('Image')}
              onPress={() => { if (state.uri !== undefined) setViewing(index) }}
              style={[styles.tile, { backgroundColor: p.main, borderColor: p.line }]}>
              {state.uri !== undefined
                ? <Image source={{ uri: state.uri }} style={styles.tileImage} resizeMode="cover" />
                : state.error !== undefined
                  ? <View style={styles.tileBody}><Text style={[type.caption, { color: p.danger }]}>{state.error}</Text><Text style={[type.caption, { color: p.ink3 }]}>{t('View it on the computer')}</Text></View>
                  : <View style={styles.tileBody}><ActivityIndicator color={p.ink3} /></View>}
            </Pressable>
          )
        })}
      </View>
      <Modal visible={viewing >= 0} animationType="fade" onRequestClose={() => setViewing(-1)}>
        <View style={styles.viewer}>
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            maximumZoomScale={3} minimumZoomScale={1}
            contentOffset={{ x: Math.max(0, viewing) * width, y: 0 }}>
            {refs.map((ref, index) => (
              <Image key={ref.attachmentId} source={states[index].uri !== undefined ? { uri: states[index].uri } : undefined}
                style={{ width, flex: 1 }} resizeMode="contain" accessibilityLabel={ref.name ?? t('Image')} />
            ))}
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={() => setViewing(-1)} style={styles.viewerClose}>
            <Text style={[typeScale.settingsRow, { color: '#fff' }]}>{t('Done')}</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  )
}

interface ImageState { uri?: string; error?: string }

function useImages(sessionId: string, refs: ImageRef[]): ImageState[] {
  const { call } = useTeam()
  const [states, setStates] = useState<ImageState[]>(() =>
    refs.map(ref => imageCache.has(`${sessionId}:${ref.attachmentId}`) ? { uri: imageCache.get(`${sessionId}:${ref.attachmentId}`) } : {}))
  const key = `${sessionId}:${refs.map(ref => ref.attachmentId).join(',')}`
  useEffect(() => {
    let live = true
    refs.forEach((ref, index) => {
      const cacheKey = `${sessionId}:${ref.attachmentId}`
      if (imageCache.has(cacheKey)) return
      call('image', { sessionId, attachmentId: ref.attachmentId })
        .then(value => {
          const uri = `data:${(value as { mime?: string })?.mime ?? 'image/png'};base64,${(value as { data?: string })?.data ?? ''}`
          imageCache.set(cacheKey, uri)
          if (live) setStates(prev => prev.map((state, i) => i === index ? { uri } : state))
        })
        .catch(error => { if (live) setStates(prev => prev.map((state, i) => i === index ? { error: String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'Failed') } : state)) })
    })
    return () => { live = false }
  }, [key])
  return states
}

// The bottom sheet a long-press opens: copy the source text or read it in a
// selectable page. ChatView mounts one of each for the whole conversation.
export function Actions({ visible, text, p, onClose, onSelect }: { visible: boolean; text: string; p: Palette; onClose: () => void; onSelect: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: p.card, borderColor: p.line }]}>
          <Pressable accessibilityRole="button" onPress={async () => { await Clipboard.setStringAsync(text); onClose() }} style={({ pressed }) => [styles.sheetRow, pressed && { backgroundColor: p.hover }]}>
            <Text style={[typeScale.settingsRow, { color: p.ink }]}>{t('Copy')}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onSelect} style={({ pressed }) => [styles.sheetRow, pressed && { backgroundColor: p.hover }]}>
            <Text style={[typeScale.settingsRow, { color: p.ink }]}>{t('Select text')}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.sheetRow, pressed && { backgroundColor: p.hover }]}>
            <Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Cancel')}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  )
}

// One folded caption row per turn: a tap lists what the tools did.
function Steps({ item, p, open, onToggle }: { item: ChatItem; p: Palette; open: boolean; onToggle: () => void }) {
  const tools = item.tools ?? []
  const seconds = typeof item.ms === 'number' ? Math.round(item.ms / 1000) : undefined
  return (
    <View style={{ alignSelf: 'center', marginVertical: 4, maxWidth: '92%' }}>
      <Pressable accessibilityRole="button" onPress={onToggle} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
        <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>
          {tools.length === 1 ? t('Used {count} tool', { count: tools.length }) : t('Used {count} tools', { count: tools.length })}{seconds !== undefined && seconds > 0 ? t(' · thought for {seconds}s', { seconds }) : ''}
        </Text>
      </Pressable>
      {open ? tools.map((tool, index) => (
        <Text key={`${tool.name}-${index}`} style={[type.caption, { color: p.ink2, textAlign: 'center' }]}>
          {tool.label ?? tool.name}{tool.ok === false ? t(' — failed') : ''}
        </Text>
      )) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.bubble, paddingHorizontal: 12, paddingVertical: 7, marginVertical: 2 },
  userBubble: { alignSelf: 'flex-end' },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { width: 120, height: 120, borderRadius: radius.bubble, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%' },
  tileBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 4 },
  viewer: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  viewerClose: { position: 'absolute', top: 50, right: 20, padding: 10 },
  reader: { flex: 1, paddingTop: 60 },
  answeredCard: { alignSelf: 'flex-end', borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 3 },
  readerClose: { position: 'absolute', bottom: 30, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.35)', justifyContent: 'flex-end' },
  sheet: { marginHorizontal: 12, marginBottom: 34, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  sheetRow: { paddingVertical: 14, paddingHorizontal: 18 },
})
