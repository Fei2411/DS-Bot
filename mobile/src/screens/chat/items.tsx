import { createContext, memo, useContext, useEffect, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ActivityIndicator, Dimensions, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { t, clockLabel, messageClock } from '../../ui/i18n.ts'
import { CheckIcon } from '../../ui/icons.tsx'
import { Avatar } from '../../ui/marks.tsx'
import type { Bot } from '../../connection.ts'
import { imPlatform } from '../../../../ds-bot/src/shared/im-platforms.js'
import { inkColor, radius, type as typeScale, useTheme, type Palette } from '../../ui/tokens.ts'
import { Markdown, hasBlockContent } from './markdown.tsx'
import { useTeam } from '../../team/context.tsx'
import { ViewCard } from './view.tsx'
import { handoffTitleOf, relayReplyText, roundEventText, settledQuestionPicks, stripLongNote, type RelayReplyData, type SettledQuestionData } from './settled.ts'
import { viewAnswerText } from 'deep-view/core'

export interface ImageRef { attachmentId: string; mime?: string; name?: string }

export interface FileRef { name: string; bytes?: number; attachmentId?: string }

export type { SettledQuestionData }

export interface ChatItem {
  kind: 'bot' | 'user' | 'event' | 'answer' | 'view' | 'divider' | 'steps' | 'closed' | 'post' | 'relay'
  text?: string
  time?: number
  seq?: number
  turn?: number
  role?: string
  // A group round's event (mobile.js replyItem): failed, missed, approval, done…
  event?: string
  code?: string
  name?: string
  botId?: string
  images?: number
  // The IM platform a user message came in over (parts.js viaOf).
  via?: string
  imageRefs?: ImageRef[]
  files?: FileRef[]
  file?: FileRef
  whole?: { file?: FileRef; length?: number }
  length?: number
  title?: string
  view?: unknown
  views?: { id: string; title: string; view: unknown }[]
  closed?: string
  question?: SettledQuestionData
  questions?: SettledQuestionData[]
  handoff?: { reason?: string; note?: string; outcome?: string }
  reply?: RelayReplyData
  answers?: { id?: string; action?: string; values?: { selected?: string[]; inputs?: Record<string, unknown>; fields?: Record<string, string>; confirmed?: boolean }; selected?: string[]; custom?: string }[]
  tools?: { name: string; label?: string | null; ok?: boolean }[]
  ms?: number
  live?: boolean
  texts?: string[]
  // Photos picked on this phone, shown from the device until the computer has them.
  localImages?: string[]
  // A message the phone sent that the computer has not shown back yet.
  local?: 'sending' | 'failed'
  localId?: string
}

// Row keys that stay the same when older pages load above or new rows arrive below,
// so the list moves rows instead of rebuilding them. A row is named by its sequence
// number or time; rows that share one are told apart by their order.
export function keysOf(items: ChatItem[]): string[] {
  const seen = new Map<string, number>()
  return items.map(item => {
    const base = item.localId !== undefined ? `local-${item.localId}` : `${item.kind}-${item.seq ?? item.time ?? (item.kind === 'steps' ? `t${item.turn ?? ''}` : '')}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}#${count}`
  })
}

// Session data URIs, kept only in memory so nothing touches disk. The chat shows
// previews; an original is fetched when its photo is opened, and only the last few stay.
const imageCache = new Map<string, string>()
const originals = new Map<string, string>()
const ORIGINALS_KEPT = 6
const dataUri = (value: unknown) => `data:${(value as { mime?: string })?.mime ?? 'image/png'};base64,${(value as { data?: string })?.data ?? ''}`

// One displayItems row (parts.js). Bubbles: radius 18, padding 7×12, Bot on the
// theme's bubble color, the user on user/userInk. `prefs.width` caps the Bot
// bubble at min(width%, 100% - 40); flat layout draws Bot text full width.
export const Item = memo(function Item({ item, p, flat, maxWidth, inRoom, sessionId, open, onToggle, onLongPress, onOpenFile, onRetry, stamp, author, admin }: { item: ChatItem; p: Palette; flat: boolean; maxWidth: number | string; inRoom: boolean; sessionId?: string; open?: boolean; onToggle?: () => void; stamp?: string; author?: Bot; admin?: boolean; onLongPress?: (text: string) => void; onOpenFile?: (file: { name: string; attachmentId?: string }) => void; onRetry?: (localId: string, discard?: boolean) => void }) {
  const { dark } = useTheme()
  const wholeFile = item.file?.attachmentId !== undefined ? item.file : item.whole?.file?.attachmentId !== undefined ? item.whole.file : undefined
  const chips = (item.files ?? []).map(file => (
    <Pressable key={file.attachmentId ?? file.name} accessibilityRole="button" onPress={() => onOpenFile?.(file)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line2, backgroundColor: p.card }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.small, { color: p.ink, fontWeight: '500' }]} numberOfLines={1}>{file.name}</Text>
        <Text style={[type.caption, { color: p.ink3 }]}>{[(file.name.split('.').pop() ?? '').toUpperCase(), file.bytes !== undefined ? `${Math.max(1, Math.round(file.bytes / 1024))} KB` : ''].filter(Boolean).join(' · ')}</Text>
      </View>
    </Pressable>
  ))
  const fullMessageLink = wholeFile !== undefined ? (
    <Pressable accessibilityRole="button" onPress={() => onOpenFile?.(wholeFile)} style={{ alignSelf: 'flex-start', marginTop: 6, paddingVertical: 2 }}>
      <Text style={[type.small, { color: p.accent, fontWeight: '500' }]}>{t('Read full message')}</Text>
    </Pressable>
  ) : null
  const bodyTexts = item.texts !== undefined && item.texts.length > 0
    ? item.texts.filter(entry => entry.trim() !== '')
    : (item.text ?? '') !== '' ? [wholeFile !== undefined ? stripLongNote(item.text ?? '') : (item.text ?? '')] : []
  const bodyJoined = bodyTexts.join('\n\n')
  const source = item.answers !== undefined
    ? item.answers.map(answer => [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])].join(', ')).join('\n')
    : bodyJoined
  const longPress = () => { void Haptics.selectionAsync(); onLongPress?.(source) }
  if (item.kind === 'steps') return <Steps item={item} p={p} open={open === true} onToggle={onToggle ?? (() => {})} />
  if (item.kind === 'divider') {
    const label = typeof item.time === 'number' ? clockLabel(item.time) : ''
    return (
      <View style={styles.partDivider} accessibilityRole="header">
        <View style={[styles.partLine, { backgroundColor: p.line }]} />
        {label !== '' ? <Text style={[type.caption, { color: p.ink3 }]}>{label}</Text> : null}
        <View style={[styles.partLine, { backgroundColor: p.line }]} />
      </View>
    )
  }
  if (item.kind === 'relay') {
    const line = relayReplyText(item.reply)
    return line ? <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, paddingHorizontal: 12, textAlign: 'center' }]}>{line}</Text> : null
  }
  if (item.kind === 'event') {
    if (item.role === 'paused') return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, paddingHorizontal: 12, textAlign: 'center' }]}>{t('Paused after {count} Bot relays. Waiting: {names}', { count: item.ms ?? 0, names: item.text ?? '' })}</Text>
    const name = item.name ?? t('a Bot')
    const round = roundEventText(name, item.event, item.text, item.code)
    if (round !== undefined) return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, paddingHorizontal: 12, textAlign: 'center' }]}>{round}</Text>
    const label = { request: t('asked for work'), reply: t('replied'), report: t('reported back'), stopped: t('stopped') }[item.role ?? ''] ?? item.role ?? ''
    return <Text style={[type.caption, { color: p.ink3, alignSelf: 'center', marginVertical: 4, paddingHorizontal: 12, textAlign: 'center' }]}>{t('{name} {event}', { name: item.name ?? t('a Bot'), event: label })}</Text>
  }
  if (item.kind === 'closed') {
    const badge = t(item.closed === 'replied' ? 'Answered by message' : 'Dismissed')
    const prompt = item.question?.question ?? item.title ?? ''
    return (
      <View style={[styles.settledCard, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={styles.settledHead}>
          <Text style={[type.small, { color: p.ink2, fontWeight: '500', flex: 1, minWidth: 0 }]}>{prompt}</Text>
          <View style={[styles.settledBadge, { borderColor: p.line2 }]}>
            <Text style={[type.caption, { color: p.ink2 }]}>{badge}</Text>
          </View>
        </View>
      </View>
    )
  }
  if (item.kind === 'view') {
    return item.view !== undefined
      ? <ViewCard sessionId={sessionId ?? ''} title={item.title} root={item.view} p={p} readOnly />
      : <View style={[styles.settledCard, { backgroundColor: p.card, borderColor: p.line }]}>
          <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{item.title ?? 'View'}</Text>
        </View>
  }
  if (item.kind === 'answer') {
    let handoff = item.handoff
    if (handoff === undefined && (item.questions ?? []).length === 0 && (item.views ?? []).length === 0 && typeof item.text === 'string') {
      try {
        const parsed = JSON.parse(item.text) as { kind?: string; reason?: string; note?: string; outcome?: string }
        if (parsed?.kind === 'answer_to_pending_handoff' && typeof parsed.reason === 'string') {
          handoff = { reason: parsed.reason, note: parsed.note, outcome: parsed.outcome }
        }
      } catch { /* plain text fallback */ }
    }
    if (handoff !== undefined) {
      const skipped = handoff.outcome === 'skipped'
      const returned = handoff.outcome === 'returned'
      const title = handoffTitleOf(handoff.reason)
      return (
        <View style={[styles.settledCard, { backgroundColor: p.card, borderColor: p.line }]}>
          <View style={styles.settledHead}>
            <Text style={[type.small, { color: p.ink2, fontWeight: '500', flex: 1, minWidth: 0 }]}>{title}</Text>
            {skipped || returned ? (
              <View style={[styles.settledBadge, { borderColor: p.line2 }]}>
                <Text style={[type.caption, { color: p.ink2 }]}>{t(skipped ? 'Skipped' : 'Returned')}</Text>
              </View>
            ) : <CheckIcon size={16} color={p.ink2} />}
          </View>
        </View>
      )
    }
    const viewReplies = (item.views ?? []).map((entry, i) => {
      const answer = (item.answers ?? []).find(a => a.id === entry.id) ?? item.answers?.[i]
      const detail = answer !== undefined && entry.view !== undefined ? viewAnswerText(entry.view, answer as never) : ''
      return { title: entry.title, detail }
    })
    if (viewReplies.length > 0) return (
      <Pressable onLongPress={longPress} style={[styles.settledCard, { backgroundColor: p.card, borderColor: p.line }]}>
        {viewReplies.map((reply, i) => (
          <View key={i} style={{ gap: 4 }}>
            {reply.title ? <Text style={[type.small, { color: p.ink2, fontWeight: '500' }]}>{reply.title}</Text> : null}
            <Text style={[type.small, { color: p.ink }]}>{reply.detail !== '' ? reply.detail : source}</Text>
          </View>
        ))}
      </Pressable>
    )
    // An answered ask_user card folds to its result across the chat column, matching the
    // desktop's SettledQuestion: full width so multi-line picks never collapse or clip.
    if ((item.questions ?? []).length > 0) return (
      <Pressable onLongPress={longPress} style={[styles.settledCard, { backgroundColor: p.card, borderColor: p.line }]}>
        {(item.questions ?? []).map((question, i) => {
          const answer = (item.answers ?? []).find(a => question.id !== undefined && a.id === question.id) ?? item.answers?.[i]
          const picks = settledQuestionPicks(question, answer)
          return (
            <View key={i} style={{ gap: 6 }}>
              <Text style={[type.small, { color: p.ink2, fontWeight: '500' }]}>{question.question}</Text>
              {picks.map((pick, j) => (
                <View key={j} style={styles.pickLine}>
                  <View style={[styles.pickBadge, { backgroundColor: p.accent }]}>
                    <Text style={{ color: p.accentInk, fontSize: 12, fontWeight: '600' }}>{pick.letter}</Text>
                  </View>
                  <Text style={[type.small, { color: p.ink, flex: 1, minWidth: 0, lineHeight: 20 }]}>{pick.label}</Text>
                </View>
              ))}
            </View>
          )
        })}
      </Pressable>
    )
    return (
      <Pressable onLongPress={longPress} style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth }]}>
        <Text style={[type.bubble, { color: p.userInk }]}>{source}</Text>
      </Pressable>
    )
  }
  if (item.kind === 'user') {
    // A user message with a code block or table takes the full width, as a Bot's does:
    // a bubble sized to its content cannot hold a block that scrolls sideways.
    const wide = hasBlockContent(item.text ?? '')
    // Photos with no text show as photos, without a bubble around them.
    const photosOnly = (item.text ?? '') === '' && chips.length === 0 && ((item.imageRefs?.length ?? 0) > 0 || (item.localImages?.length ?? 0) > 0)
    const bubble = (
      <Pressable onLongPress={longPress} onPress={item.local === 'failed' && item.localId !== undefined ? () => onRetry?.(item.localId!) : undefined}
        style={[styles.bubble, styles.userBubble, { backgroundColor: p.user, maxWidth, width: wide ? maxWidth : undefined, opacity: item.local === 'sending' ? 0.7 : 1 },
          photosOnly ? { backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0 } : null]}>
        {item.text ? <Markdown text={item.text} p={p} textColor={p.userInk} bg={p.user} /> : null}
        {chips}
        {item.localImages !== undefined && item.localImages.length > 0
          ? <LocalImages uris={item.localImages} />
          : item.imageRefs !== undefined && item.imageRefs.length > 0 && sessionId !== undefined
            ? <ImageGrid refs={item.imageRefs} sessionId={sessionId} p={p} />
            : item.images ? <Text style={[type.caption, { color: p.userInk, opacity: 0.8, marginTop: 4 }]}>{t('{count} images', { count: item.images })}</Text> : null}
      </Pressable>
    )
    if (item.local === 'failed') return (
      <View style={{ alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth }}>
        {bubble}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginRight: 2 }}>
          <Text accessibilityRole="button" onPress={() => onRetry?.(item.localId!)} style={[type.caption, { color: p.danger }]}>{t('Not sent. Tap to retry')}</Text>
          <Text accessibilityRole="button" onPress={() => onRetry?.(item.localId!, true)} style={[type.caption, { color: p.ink3 }]}>{t('Delete')}</Text>
        </View>
      </View>
    )
    // user-message.js: the time under the bubble, after an IM message's platform tag.
    return stamp || item.via ? (
      <View style={{ alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth }}>
        {bubble}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, marginRight: 2 }}>
          {item.via ? <Text style={[styles.via, { backgroundColor: p.hover, color: p.ink3 }]}>{t('via {platform}', { platform: imPlatform(item.via)?.name ?? item.via })}</Text> : null}
          {stamp ? <Text style={[type.caption, { color: p.ink3 }]}>{stamp}</Text> : null}
        </View>
      </View>
    ) : bubble
  }
  const hasImages = item.imageRefs !== undefined && item.imageRefs.length > 0 && sessionId !== undefined
  if (bodyTexts.length === 0 && !hasImages && chips.length === 0 && fullMessageLink === null) return null
  // In a group each reply carries its member: avatar, name in the member's color, the
  // admin tag and the time, as the desktop's group rows do.
  if (inRoom && !flat) {
    const wide = bodyTexts.some(hasBlockContent) || hasImages
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 6 }}>
        <View style={{ width: 22, paddingTop: 22 }}>{author ? <Avatar bot={author} dark={dark} size={22} ring={p.main} /> : null}</View>
        <Pressable onLongPress={longPress} style={{ flexShrink: 1, minWidth: 0, maxWidth, width: wide ? maxWidth : undefined }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3, marginLeft: 2 }}>
            <Text style={[type.caption, { color: author !== undefined ? inkColor(author.color, dark) : p.ink2, fontWeight: '500', flexShrink: 1 }]} numberOfLines={1}>{item.name ?? author?.name ?? ''}</Text>
            {admin ? <Text style={[styles.via, { backgroundColor: p.hover, color: p.ink3 }]}>{t('Admin')}</Text> : null}
            {typeof item.time === 'number' ? <Text style={[type.caption, { color: p.ink3 }]}>{messageClock(item.time)}</Text> : null}
          </View>
          {bodyTexts.map((partText, bi) => {
            const last = bi === bodyTexts.length - 1
            return (
              <View key={bi} style={[styles.bubble, { backgroundColor: p.bubble, alignSelf: hasBlockContent(partText) || (last && hasImages) ? 'stretch' : 'flex-start', maxWidth: '100%' }]}>
                <Markdown text={partText} p={p} textColor={p.ink} bg={p.bubble} />
                {last && hasImages ? <ImageGrid refs={item.imageRefs!} sessionId={sessionId!} p={p} /> : null}
                {last ? chips : null}
                {last ? fullMessageLink : null}
              </View>
            )
          })}
          {bodyTexts.length === 0 ? (
            <View style={[styles.bubble, { backgroundColor: p.bubble, alignSelf: 'flex-start', maxWidth: '100%' }]}>
              {hasImages ? <ImageGrid refs={item.imageRefs!} sessionId={sessionId!} p={p} /> : null}
              {chips}
              {fullMessageLink}
            </View>
          ) : null}
        </Pressable>
      </View>
    )
  }
  const name = inRoom && item.name ? <Text style={[type.caption, { color: p.ink3, marginBottom: 2, marginLeft: 2 }]}>{item.name}</Text> : null
  const wide = bodyTexts.some(hasBlockContent) || hasImages
  if (flat) {
    return (
      <Pressable onLongPress={longPress} style={{ alignSelf: 'stretch', marginVertical: 4 }}>
        {name}
        {bodyTexts.length > 0 ? <Markdown text={bodyJoined} p={p} textColor={p.ink} bg={p.main} /> : null}
        {hasImages ? <ImageGrid refs={item.imageRefs!} sessionId={sessionId!} p={p} /> : null}
        {chips}
        {fullMessageLink}
        {stamp ? <Text style={[type.caption, { color: p.ink3, marginTop: 4 }]}>{stamp}</Text> : null}
      </Pressable>
    )
  }
  return (
    <Pressable onLongPress={longPress} style={{ alignSelf: 'flex-start', maxWidth, width: wide ? maxWidth : undefined }}>
      {name}
      <View style={[styles.bubble, { backgroundColor: p.bubble, maxWidth: '100%' }]}>
        {bodyTexts.length > 0 ? <Markdown text={bodyJoined} p={p} textColor={p.ink} bg={p.bubble} /> : null}
        {hasImages ? <ImageGrid refs={item.imageRefs!} sessionId={sessionId!} p={p} /> : null}
        {chips}
        {fullMessageLink}
      </View>
      {stamp ? <Text style={[type.caption, { color: p.ink3, marginTop: 2, marginLeft: 4 }]}>{stamp}</Text> : null}
    </Pressable>
  )
})

const type = typeScale

// Photos the phone is sending, shown from the phone itself until the computer has them.
function LocalImages({ uris }: { uris: string[] }) {
  const { tile, width } = gridOf(uris.length)
  return (
    <View style={[styles.grid, { gap: GRID_GAP, marginTop: 6, width }]}>
      {uris.map(uri => <Image key={uri} source={{ uri }} style={[styles.tile, { width: tile, height: tile, borderWidth: 0 }]} resizeMode="cover" />)}
    </View>
  )
}

// One photo shows large; several sit two to a row.
const GRID_GAP = 6
const gridOf = (count: number) => {
  const tile = count === 1 ? 200 : 120
  const columns = Math.min(count, 2)
  return { tile, width: tile * columns + GRID_GAP * (columns - 1) }
}

// The photo grid inside a bubble: two columns of ~120px squares fetched once per
// attachment. A failed tile says why and points at the computer.
// Opens the chat's one photo viewer. The viewer lives outside the message list: a
// modal inside an inverted list row does not take touches.
export const PhotoViewerCtx = createContext<(open: { sessionId: string; refs: ImageRef[]; index: number }) => void>(() => {})

function ImageGrid({ refs, sessionId, p }: { refs: ImageRef[]; sessionId: string; p: Palette }) {
  const states = useImages(sessionId, refs)
  const view = useContext(PhotoViewerCtx)
  const grid = gridOf(refs.length)
  return (
    <View style={{ marginTop: 6 }}>
      <View style={[styles.grid, { gap: GRID_GAP, width: grid.width }]}>
        {refs.map((ref, index) => {
          const state = states[index]
          return (
            <Pressable key={ref.attachmentId} accessibilityRole="imagebutton" accessibilityLabel={ref.name ?? t('Image')}
              onPress={() => { if (state.uri !== undefined) view({ sessionId, refs, index }) }}
              style={[styles.tile, { width: grid.tile, height: grid.tile, backgroundColor: p.main, borderColor: p.line }]}>
              {state.uri !== undefined
                ? <Image source={{ uri: state.uri }} style={styles.tileImage} resizeMode="cover" />
                : state.error !== undefined
                  ? <View style={styles.tileBody}><Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{t('View it on the computer')}</Text></View>
                  : <View style={styles.tileBody}><ActivityIndicator color={p.ink3} /></View>}
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

// Full-screen photos, swiped side to side: the preview at once, the original once it arrives.
export function PhotoViewer({ open, onClose }: { open: { sessionId: string; refs: ImageRef[]; index: number } | null; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const width = Dimensions.get('window').width
  const [at, setAt] = useState(0)
  useEffect(() => { if (open !== null) setAt(open.index) }, [open])
  const refs = open?.refs ?? []
  const states = useImages(open?.sessionId ?? '', refs)
  const whole = useOriginal(open?.sessionId ?? '', open !== null ? refs[at] : undefined)
  return (
    <Modal visible={open !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        {open !== null ? (
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            contentOffset={{ x: open.index * width, y: 0 }}
            onMomentumScrollEnd={event => setAt(Math.round(event.nativeEvent.contentOffset.x / width))}>
            {refs.map((ref, index) => {
              const uri = (index === at ? whole : undefined) ?? states[index]?.uri
              return (
                <Pressable key={ref.attachmentId} onPress={onClose} style={{ width, flex: 1, justifyContent: 'center' }}>
                  {uri !== undefined ? <Image source={{ uri }} style={{ width, height: '100%' }} resizeMode="contain" accessibilityLabel={ref.name ?? t('Image')} /> : <ActivityIndicator color="#fff" />}
                </Pressable>
              )
            })}
          </ScrollView>
        ) : null}
        <View style={[styles.viewerBar, { top: insets.top + 6 }]} pointerEvents="box-none">
          {refs.length > 1 ? <Text style={[typeScale.small, { color: 'rgba(255,255,255,0.8)' }]}>{`${at + 1} / ${refs.length}`}</Text> : <View />}
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10} style={styles.viewerClose}>
            <Text style={[typeScale.settingsRow, { color: '#fff' }]}>{t('Done')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

interface ImageState { uri?: string; error?: string }

function useImages(sessionId: string, refs: ImageRef[]): ImageState[] {
  const { call } = useTeam()
  const [, bump] = useState(0)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = `${sessionId}:${refs.map(ref => ref.attachmentId).join(',')}`
  useEffect(() => {
    let live = true
    for (const ref of refs) {
      const cacheKey = `${sessionId}:${ref.attachmentId}`
      if (imageCache.has(cacheKey)) continue
      call('image', { sessionId, attachmentId: ref.attachmentId, preview: true })
        .then(value => {
          imageCache.set(cacheKey, dataUri(value))
          if (live) bump(n => n + 1)
        })
        .catch(error => {
          const reason = String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'Failed')
          if (live) setErrors(prev => ({ ...prev, [cacheKey]: reason }))
        })
    }
    return () => { live = false }
  }, [key])
  return refs.map(ref => {
    const cacheKey = `${sessionId}:${ref.attachmentId}`
    const uri = imageCache.get(cacheKey)
    return uri !== undefined ? { uri } : errors[cacheKey] !== undefined ? { error: errors[cacheKey] } : {}
  })
}

// The original of the photo open in the viewer; the preview shows until it arrives.
function useOriginal(sessionId: string, ref: ImageRef | undefined): string | undefined {
  const { call } = useTeam()
  const key = ref === undefined ? undefined : `${sessionId}:${ref.attachmentId}`
  const [uri, setUri] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (key === undefined || ref === undefined) { setUri(undefined); return }
    const kept = originals.get(key)
    setUri(kept)
    if (kept !== undefined) return
    let live = true
    call('image', { sessionId, attachmentId: ref.attachmentId })
      .then(value => {
        const next = dataUri(value)
        originals.set(key, next)
        while (originals.size > ORIGINALS_KEPT) originals.delete(originals.keys().next().value as string)
        if (live) setUri(next)
      })
      .catch(() => {})
    return () => { live = false }
  }, [key])
  return uri
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
          {(tool.label ? t(tool.label) : undefined) ?? tool.name}{tool.ok === false ? t(' — failed') : ''}
        </Text>
      )) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.bubble, paddingHorizontal: 14, paddingVertical: 9, marginVertical: 2 },
  userBubble: { alignSelf: 'flex-end' },
  partDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12 },
  partLine: { flex: 1, height: StyleSheet.hairlineWidth },
  settledCard: { alignSelf: 'stretch', width: '100%', borderRadius: radius.dialog, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 12, marginVertical: 6, gap: 8 },
  settledHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  settledBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderStyle: 'dashed', flexShrink: 0 },
  pickBadge: { width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginTop: 1, flexShrink: 0 },
  pickLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { width: 120, height: 120, borderRadius: radius.bubble, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%' },
  tileBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 4 },
  viewer: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  viewerBar: { position: 'absolute', left: 16, right: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  viewerClose: { padding: 10 },
  reader: { flex: 1, paddingTop: 60 },
  via: { fontSize: 11, lineHeight: 16, paddingHorizontal: 6, borderRadius: 6, overflow: 'hidden', flexShrink: 0 },
  readerClose: { position: 'absolute', bottom: 30, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.35)', justifyContent: 'flex-end' },
  sheet: { marginHorizontal: 12, marginBottom: 34, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  sheetRow: { paddingVertical: 14, paddingHorizontal: 18 },
})
