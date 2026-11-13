import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ScrollView as GHScrollView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import Svg, { Defs, LinearGradient, Rect, Stop, SvgXml } from 'react-native-svg'
import { lexer, type Token, type Tokens } from 'marked'
import { useTeam } from '../../team/context.tsx'
import { t } from '../../ui/i18n.ts'
import { MONO, radius, type as typeScale, type Palette } from '../../ui/tokens.ts'
import {
  computeTableWidths,
  listItemInfo,
  normalizeSoftBreaks,
  splitParagraphImages,
  tableToTsv,
} from './markdown-model.ts'

// Markdown in Bot text: the marked lexer walks the block tokens; each block maps
// to RN views. Tables and fenced code scroll horizontally via RNGH so pan gestures
// do not conflict with Android text selection or outer lists.

const lexed = new Map<string, Token[]>()
const LEXED_KEPT = 400
function tokensOf(text: string): Token[] {
  const kept = lexed.get(text)
  if (kept !== undefined) return kept
  const tokens = lexer(text)
  lexed.set(text, tokens)
  if (lexed.size > LEXED_KEPT) lexed.delete(lexed.keys().next().value as string)
  return tokens
}

// A message that has any block that lays out wider than its text (list, code,
// table, heading, rule, quote, image) needs the bubble's full width to wrap inside it.
export function hasBlockContent(text: string): boolean {
  return text !== '' && tokensOf(text).some(token => {
    if (token.type === 'space') return false
    if (token.type !== 'paragraph' && token.type !== 'text') return true
    const inlines = (token as { tokens?: Token[] }).tokens ?? []
    return splitParagraphImages(inlines).some(seg => seg.kind === 'image')
  })
}

export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (hex !== undefined) return `rgba(${[0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color)?.[1]?.split(',').slice(0, 3).join(',')
  return rgb !== undefined ? `rgba(${rgb},${alpha})` : color
}

interface Ink { text: string; muted: string; line: string; fill: string; bg: string }

export function Markdown({ text, p, textColor, bg, fontSize = 16, lineHeight = 25, sessionId, botId }: {
  text: string; p: Palette; textColor: string; bg?: string; fontSize?: number; lineHeight?: number; sessionId?: string; botId?: string
}) {
  const blocks = tokensOf(text).filter(token => token.type !== 'space')
  const ink: Ink = { text: textColor, muted: tint(textColor, 0.48), line: tint(textColor, 0.14), fill: tint(textColor, 0.07), bg: bg ?? p.bubble }
  return (
    <View>
      {blocks.map((token, index) => (
        <Block key={index} token={token} p={p} ink={ink} textColor={textColor} fs={fontSize} lh={lineHeight}
          sessionId={sessionId} botId={botId} listDepth={0} first={index === 0} last={index === blocks.length - 1} />
      ))}
    </View>
  )
}

function tokenPlainText(tokens?: Token[]): string {
  if (!Array.isArray(tokens)) return ''
  let out = ''
  for (const token of tokens) {
    if (token.type === 'br') out += '\n'
    else if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) out += tokenPlainText((token as { tokens: Token[] }).tokens)
    else if ('text' in token) out += String(token.text ?? '')
    else if ('raw' in token) out += String(token.raw ?? '')
  }
  return out
}

function Block({ token, p, ink, textColor, fs, lh, sessionId, botId, listDepth = 0, first = false, last = false }: {
  token: Token; p: Palette; ink: Ink; textColor: string; fs: number; lh: number
  sessionId?: string; botId?: string; listDepth?: number; first?: boolean; last?: boolean
}) {
  const base = { color: textColor, fontSize: fs, lineHeight: lh }
  const top = (gap: number) => (first ? 0 : gap)
  const bottom = (gap: number) => (last ? 0 : gap)
  switch (token.type) {
    case 'heading': {
      const depth = (token as Tokens.Heading).depth
      const size = depth === 1 ? fs + 4 : depth === 2 ? fs + 2 : fs + 1
      const headingLh = Math.round(size * 1.4)
      return (
        <Text selectable style={[base, { fontSize: size, lineHeight: headingLh, fontWeight: '600', marginTop: top(12), marginBottom: bottom(4) }]}>
          <Inlines tokens={(token as Tokens.Heading).tokens ?? []} p={p} color={textColor} fs={size} />
        </Text>
      )
    }
    case 'paragraph': {
      const segments = splitParagraphImages((token as Tokens.Paragraph).tokens ?? [])
      return (
        <View style={{ marginTop: top(8), marginBottom: bottom(2), gap: 6 }}>
          {segments.map((seg, si) => seg.kind === 'inlines' ? (
            <Text key={si} selectable style={base}>
              <Inlines tokens={seg.tokens} p={p} color={textColor} fs={fs} />
            </Text>
          ) : (
            <MarkdownImage key={si} href={seg.href} alt={seg.alt} linkHref={seg.linkHref} p={p} ink={ink} sessionId={sessionId} botId={botId} />
          ))}
        </View>
      )
    }
    case 'code': {
      const code = (token as Tokens.Code)
      return (
        <View style={{ backgroundColor: ink.fill, borderRadius: radius.input, marginTop: top(6), marginBottom: bottom(6), borderWidth: 1, borderColor: ink.line, overflow: 'hidden' }}>
          <HScroll fade={ink.bg}>
            {/* selectable on Android TextView intercepts horizontal drag gestures */}
            <Text selectable={Platform.OS !== 'android'} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : MONO, fontSize: 13, lineHeight: 19, color: textColor, paddingHorizontal: 12, paddingVertical: 9 }}>{code.text}</Text>
          </HScroll>
        </View>
      )
    }
    case 'list': {
      const list = token as Tokens.List
      return (
        <View style={{ marginTop: top(6), marginBottom: bottom(4), marginLeft: listDepth > 0 ? 12 : 0, gap: 6 }}>
          {list.items.map((item, index) => {
            const info = listItemInfo(list, item, index, listDepth)
            return (
              <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <Text style={[base, { color: info.checked ? p.accent : ink.muted, minWidth: list.ordered ? 26 : 18, paddingRight: list.ordered ? 6 : 4, fontVariant: ['tabular-nums'] }]}>
                  {info.marker}
                </Text>
                <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                  {info.tokens.map((inner, bi) => (
                    <Block key={bi} token={inner} p={p} ink={ink} textColor={textColor} fs={fs} lh={lh}
                      sessionId={sessionId} botId={botId} listDepth={listDepth + 1} first={bi === 0} last={bi === info.tokens.length - 1} />
                  ))}
                </View>
              </View>
            )
          })}
        </View>
      )
    }
    case 'blockquote': {
      const innerTokens = ((token as Tokens.Blockquote).tokens ?? []).filter(inner => inner.type !== 'space')
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: ink.line, paddingLeft: 10, marginTop: top(6), marginBottom: bottom(6) }}>
          {innerTokens.map((inner, index) => (
            <Block key={index} token={inner} p={p} ink={ink} textColor={textColor} fs={fs} lh={lh}
              sessionId={sessionId} botId={botId} listDepth={listDepth} first={index === 0} last={index === innerTokens.length - 1} />
          ))}
        </View>
      )
    }
    case 'table':
      return <MarkdownTable table={token as Tokens.Table} p={p} ink={ink} textColor={textColor} fs={fs} lh={lh} top={top(6)} bottom={bottom(6)} />
    case 'hr':
      return <View style={{ height: 1, backgroundColor: ink.line, marginTop: top(10), marginBottom: bottom(10) }} />
    case 'space':
      return null
    case 'text': {
      const textToken = token as Tokens.Text
      if (Array.isArray(textToken.tokens) && textToken.tokens.length > 0) {
        const segments = splitParagraphImages(textToken.tokens)
        return (
          <View style={{ gap: 4 }}>
            {segments.map((seg, si) => seg.kind === 'inlines' ? (
              <Text key={si} selectable style={base}>
                <Inlines tokens={seg.tokens} p={p} color={textColor} fs={fs} />
              </Text>
            ) : (
              <MarkdownImage key={si} href={seg.href} alt={seg.alt} linkHref={seg.linkHref} p={p} ink={ink} sessionId={sessionId} botId={botId} />
            ))}
          </View>
        )
      }
      return <Text selectable style={base}>{normalizeSoftBreaks(textToken.text)}</Text>
    }
    default:
      return 'raw' in token && typeof token.raw === 'string' && token.raw.trim() !== ''
        ? <Text selectable style={base}>{normalizeSoftBreaks(token.raw)}</Text> : null
  }
}

function MarkdownTable({ table, p, ink, textColor, fs, lh, top, bottom }: {
  table: Tokens.Table; p: Palette; ink: Ink; textColor: string; fs: number; lh: number; top: number; bottom: number
}) {
  const [boxWidth, setBoxWidth] = useState(0)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const insets = useSafeAreaInsets()

  const headerTexts = useMemo(() => table.header.map(c => tokenPlainText(c.tokens)), [table.header])
  const rowTexts = useMemo(() => table.rows.map(r => r.map(c => tokenPlainText(c.tokens))), [table.rows])
  const colWidths = useMemo(() => computeTableWidths(headerTexts, rowTexts, { containerWidth: Math.max(0, boxWidth - 2) }), [headerTexts, rowTexts, boxWidth])

  const renderGrid = (selectableText: boolean) => (
    <View style={{ borderWidth: 1, borderColor: ink.line, borderRadius: radius.input, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', backgroundColor: ink.fill }}>
        {table.header.map((cell, ci) => (
          <View key={ci} style={{ width: colWidths[ci] ?? 100, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: ci > 0 ? StyleSheet.hairlineWidth : 0, borderLeftColor: ink.line }}>
            <Text selectable={selectableText} style={{ color: textColor, fontSize: fs - 1, lineHeight: lh - 4, fontWeight: '600' }}>
              <Inlines tokens={cell.tokens ?? []} p={p} color={textColor} fs={fs - 1} />
            </Text>
          </View>
        ))}
      </View>
      {table.rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: ink.line }}>
          {table.header.map((_, ci) => {
            const cell = row[ci]
            return (
              <View key={ci} style={{ width: colWidths[ci] ?? 100, paddingHorizontal: 10, paddingVertical: 7, borderLeftWidth: ci > 0 ? StyleSheet.hairlineWidth : 0, borderLeftColor: ink.line }}>
                <Text selectable={selectableText} style={{ color: textColor, fontSize: fs - 1, lineHeight: lh - 4 }}>
                  <Inlines tokens={cell?.tokens ?? []} p={p} color={textColor} fs={fs - 1} />
                </Text>
              </View>
            )
          })}
        </View>
      ))}
    </View>
  )

  const copyTable = () => {
    void Clipboard.setStringAsync(tableToTsv(headerTexts, rowTexts)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <View style={{ marginTop: top, marginBottom: bottom }} onLayout={e => setBoxWidth(e.nativeEvent.layout.width)}>
      <HScroll fade={ink.bg} showIndicator>
        {renderGrid(Platform.OS !== 'android')}
      </HScroll>
      <View style={styles.tableBar}>
        <Pressable accessibilityRole="button" onPress={copyTable} hitSlop={6} style={[styles.tableBtn, { backgroundColor: ink.fill, borderColor: ink.line }]}>
          <Text style={[typeScale.caption, { color: copied ? p.accent : ink.muted }]}>{copied ? t('Copied') : t('Copy')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} hitSlop={6} style={[styles.tableBtn, { backgroundColor: ink.fill, borderColor: ink.line }]}>
          <Text style={[typeScale.caption, { color: ink.muted }]}>{t('Expand')}</Text>
        </Pressable>
      </View>
      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)} statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }}>
          <View style={styles.modalHead}>
            <Text style={[typeScale.headerTitle, { color: p.ink }]}>{t('Table')}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable accessibilityRole="button" onPress={copyTable} style={[styles.tableBtn, { backgroundColor: p.hover, borderColor: p.line }]}>
                <Text style={[typeScale.small, { color: copied ? p.accent : p.ink2 }]}>{copied ? t('Copied') : t('Copy')}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => setExpanded(false)} style={[styles.tableBtn, { backgroundColor: p.accent, borderColor: p.accent }]}>
                <Text style={[typeScale.small, { color: p.accentInk, fontWeight: '600' }]}>{t('Done')}</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView contentContainerStyle={{ padding: 14 }}>
            <GHScrollView horizontal nestedScrollEnabled directionalLockEnabled showsHorizontalScrollIndicator>
              <View style={{ borderWidth: 1, borderColor: p.line2, borderRadius: radius.input, overflow: 'hidden', backgroundColor: p.card }}>
                <View style={{ flexDirection: 'row', backgroundColor: p.hover }}>
                  {table.header.map((cell, ci) => (
                    <View key={ci} style={{ width: colWidths[ci] ?? 110, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: ci > 0 ? StyleSheet.hairlineWidth : 0, borderLeftColor: p.line2 }}>
                      <Text selectable style={{ color: p.ink, fontSize: fs - 1, lineHeight: lh - 4, fontWeight: '600' }}>
                        <Inlines tokens={cell.tokens ?? []} p={p} color={p.ink} fs={fs - 1} />
                      </Text>
                    </View>
                  ))}
                </View>
                {table.rows.map((row, ri) => (
                  <View key={ri} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: p.line }}>
                    {table.header.map((_, ci) => (
                      <View key={ci} style={{ width: colWidths[ci] ?? 110, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: ci > 0 ? StyleSheet.hairlineWidth : 0, borderLeftColor: p.line2 }}>
                        <Text selectable style={{ color: p.ink, fontSize: fs - 1, lineHeight: lh - 4 }}>
                          <Inlines tokens={row[ci]?.tokens ?? []} p={p} color={p.ink} fs={fs - 1} />
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </GHScrollView>
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

const MD_IMAGE_TTL_MS = 15_000
type MdImageEntry = { uri?: string; svg?: string; rev?: string; at: number }
const mdImageCache = new Map<string, MdImageEntry>()
const MD_IMAGES_KEPT = 64
let mdImageEpoch = 0
const mdImageListeners = new Set<(epoch: number) => void>()

export function bumpMarkdownImageCache(): void {
  mdImageEpoch += 1
  for (const entry of mdImageCache.values()) entry.at = 0
  for (const listener of mdImageListeners) listener(mdImageEpoch)
}

function keepMdImage(key: string, value: { uri?: string; svg?: string; rev?: string }) {
  mdImageCache.set(key, { ...value, at: Date.now() })
  if (mdImageCache.size > MD_IMAGES_KEPT) {
    const oldest = mdImageCache.keys().next().value
    if (oldest !== undefined) mdImageCache.delete(oldest)
  }
}

function MarkdownImage({ href, alt, linkHref, p, ink, sessionId, botId }: {
  href: string; alt: string; linkHref?: string; p: Palette; ink: Ink; sessionId?: string; botId?: string
}) {
  const { call } = useTeam()
  const remote = /^https?:\/\//i.test(href) || /^data:image\//i.test(href)
  const cacheKey = remote ? href : `${sessionId ?? ''}:${botId ?? ''}:${href}`
  const [loaded, setLoaded] = useState<{ uri?: string; svg?: string; rev?: string } | null>(() => (remote ? { uri: href } : mdImageCache.get(cacheKey) ?? null))
  const [failed, setFailed] = useState(false)
  const [aspect, setAspect] = useState<number>(16 / 9)
  const [open, setOpen] = useState(false)
  const [epoch, setEpoch] = useState(mdImageEpoch)
  const lastKeyRef = useRef(cacheKey)
  const insets = useSafeAreaInsets()

  useEffect(() => {
    const sync = (next: number) => setEpoch(next)
    mdImageListeners.add(sync)
    if (mdImageEpoch !== epoch) setEpoch(mdImageEpoch)
    return () => { mdImageListeners.delete(sync) }
  }, [])

  useEffect(() => {
    setFailed(false)
    if (remote) { setLoaded({ uri: href }); return }
    const cached = mdImageCache.get(cacheKey)
    if (lastKeyRef.current !== cacheKey) {
      lastKeyRef.current = cacheKey
      setLoaded(cached ?? null)
    } else if (cached !== undefined) {
      setLoaded(cached)
    }
    if (cached !== undefined && Date.now() - cached.at < MD_IMAGE_TTL_MS) return
    if (!sessionId || !href) { setFailed(true); return }
    let active = true
    void call('markdown-image', { sessionId, path: href, ...(botId ? { botId } : {}), ...(cached?.rev ? { knownRev: cached.rev } : {}) })
      .then(result => {
        if (!active) return
        const res = result as { mime?: string; bytes?: string; rev?: string; unchanged?: boolean }
        if (res?.unchanged === true && cached !== undefined) {
          keepMdImage(cacheKey, { uri: cached.uri, svg: cached.svg, rev: res.rev ?? cached.rev })
          return
        }
        if (typeof res?.bytes !== 'string' || res.bytes === '') { setFailed(true); return }
        const mime = res.mime ?? 'image/png'
        if (mime === 'image/svg+xml') {
          try {
            const svg = decodeURIComponent(escape(atob(res.bytes)))
            const next = { svg, rev: res.rev }
            keepMdImage(cacheKey, next)
            setLoaded(prev => (prev?.rev !== undefined && prev.rev === next.rev && prev.svg === next.svg ? prev : next))
          } catch { setFailed(true) }
        } else {
          const uri = `data:${mime};base64,${res.bytes}`
          const next = { uri, rev: res.rev }
          keepMdImage(cacheKey, next)
          setLoaded(prev => (prev?.rev !== undefined && prev.rev === next.rev && prev.uri === next.uri ? prev : next))
        }
      })
      .catch(() => { if (active && mdImageCache.get(cacheKey) === undefined) setFailed(true) })
    return () => { active = false }
  }, [call, cacheKey, href, remote, sessionId, botId, epoch])

  const onPress = useCallback(() => {
    if (linkHref && /^https?:\/\//i.test(linkHref)) void Linking.openURL(linkHref).catch(() => {})
    else if (loaded?.uri) setOpen(true)
  }, [linkHref, loaded?.uri])

  if (failed || !href) {
    return (
      <View style={[styles.imgFallback, { borderColor: ink.line, backgroundColor: ink.fill }]}>
        <Text style={[typeScale.caption, { color: ink.muted }]}>{alt || t('Image')}</Text>
      </View>
    )
  }

  return (
    <View style={{ marginVertical: 4 }}>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt || t('Image')} onPress={onPress}
        style={[styles.imgFrame, { borderColor: ink.line, backgroundColor: ink.fill }]}>
        {loaded?.svg ? (
          <SvgXml xml={loaded.svg} width="100%" height={180} />
        ) : loaded?.uri ? (
          <Image
            source={{ uri: loaded.uri }}
            style={{ width: '100%', aspectRatio: aspect, maxHeight: 280, minHeight: 72 }}
            resizeMode="contain"
            onLoad={e => {
              const { width, height } = e.nativeEvent.source ?? {}
              if (width > 0 && height > 0) setAspect(Math.min(2.5, Math.max(0.5, width / height)))
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <View style={styles.imgFallback}><Text style={[typeScale.caption, { color: ink.muted }]}>{alt || t('Image')}</Text></View>
        )}
      </Pressable>
      <Modal visible={open && loaded?.uri !== undefined} animationType="fade" transparent onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable onPress={() => setOpen(false)} style={styles.imgViewer}>
          {loaded?.uri ? <Image source={{ uri: loaded.uri }} style={{ width: '100%', height: '82%' }} resizeMode="contain" /> : null}
          <Pressable onPress={() => setOpen(false)} style={[styles.imgClose, { top: insets.top + 10 }]}>
            <Text style={[typeScale.settingsRow, { color: '#fff' }]}>{t('Done')}</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function HScroll({ children, fade: background, showIndicator = false }: {
  children: React.ReactNode; fade: string; showIndicator?: boolean
}) {
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '_')
  const [fade, setFade] = useState(false)
  const layout = useRef({ width: 0, content: 0, x: 0 })
  const check = () => setFade(layout.current.content > layout.current.width + 1 && layout.current.x < layout.current.content - layout.current.width - 8)
  return (
    <View>
      <GHScrollView
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={showIndicator}
        style={{ flexGrow: 0 }}
        onLayout={e => { layout.current.width = e.nativeEvent.layout.width; check() }}
        onContentSizeChange={w => { layout.current.content = w; check() }}
        onScroll={e => { layout.current.x = e.nativeEvent.contentOffset.x; check() }}
        scrollEventThrottle={32}>
        {children}
      </GHScrollView>
      {fade ? (
        <View style={{ position: 'absolute', top: 1, bottom: 1, right: 1, width: 28 }} pointerEvents="none">
          <Svg width={28} height="100%" preserveAspectRatio="none" viewBox="0 0 28 10">
            <Defs>
              <LinearGradient id={`fade_${gradId}`} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={background} stopOpacity="0" />
                <Stop offset="1" stopColor={background} stopOpacity="1" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="28" height="10" fill={`url(#fade_${gradId})`} />
          </Svg>
        </View>
      ) : null}
    </View>
  )
}

const endsHan = (token?: Token) => token !== undefined && 'text' in token && /[\u4e00-\u9fff]$/.test(String(token.text))
const startsHan = (token?: Token) => token !== undefined && 'text' in token && /^[\u4e00-\u9fff]/.test(String(token.text))

function Inlines({ tokens, p, color, fs = 16 }: { tokens: Token[]; p: Palette; color: string; fs?: number }) {
  return (
    <>
      {tokens.map((token, index) => {
        const node = <Inline key={index} token={token} p={p} color={color} fs={fs} />
        if (token.type !== 'codespan') return node
        const lead = endsHan(tokens[index - 1]) ? '\u2006' : ''
        const trail = startsHan(tokens[index + 1]) ? '\u2006' : ''
        return lead || trail ? <Text key={index}>{lead}{node}{trail}</Text> : node
      })}
    </>
  )
}

function Inline({ token, p, color, fs }: { token: Token; p: Palette; color: string; fs: number }): React.ReactNode {
  switch (token.type) {
    case 'strong':
      return <Text style={{ fontWeight: '600' }}><Inlines tokens={(token as Tokens.Strong).tokens ?? []} p={p} color={color} fs={fs} /></Text>
    case 'em':
      return <Text style={{ fontStyle: 'italic' }}><Inlines tokens={(token as Tokens.Em).tokens ?? []} p={p} color={color} fs={fs} /></Text>
    case 'codespan':
      return (
        <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : MONO, fontSize: Math.max(12.5, fs - 2.5), backgroundColor: tint(color, 0.05) }}>
          {(token as Tokens.Codespan).text}
        </Text>
      )
    case 'link': {
      const link = token as Tokens.Link
      // Bot text is untrusted: only web and mail links open; other schemes drop
      // to plain text so a crafted intent:/file: URL can never fire.
      const safe = /^https?:/i.test(link.href) || /^mailto:/i.test(link.href)
      if (!safe) return <Inlines tokens={link.tokens ?? []} p={p} color={color} fs={fs} />
      return (
        <Text style={{ color: p.accent, textDecorationLine: 'underline' }}
          onPress={() => void Linking.openURL(link.href).catch(() => {})}
          suppressHighlighting>
          <Inlines tokens={link.tokens ?? []} p={p} color={color} fs={fs} />
        </Text>
      )
    }
    case 'del':
      return <Text style={{ textDecorationLine: 'line-through' }}><Inlines tokens={(token as Tokens.Del).tokens ?? []} p={p} color={color} fs={fs} /></Text>
    case 'br':
      return '\n'
    case 'text': {
      const tk = token as Tokens.Text
      return Array.isArray(tk.tokens) && tk.tokens.length > 0
        ? <Inlines tokens={tk.tokens} p={p} color={color} fs={fs} />
        : normalizeSoftBreaks(String(tk.text ?? ''))
    }
    case 'image':
      return <Text style={{ color: tint(color, 0.45) }}>{(token as Tokens.Image).text || t('Image')}</Text>
    default:
      if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
        return <Inlines tokens={(token as { tokens: Token[] }).tokens} p={p} color={color} fs={fs} />
      }
      return 'text' in token ? normalizeSoftBreaks(String(token.text)) : ('raw' in token ? normalizeSoftBreaks(String(token.raw)) : null)
  }
}

const styles = StyleSheet.create({
  tableBar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  tableBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.item, borderWidth: StyleSheet.hairlineWidth },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10 },
  imgFrame: { borderRadius: radius.input, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  imgFallback: { borderRadius: radius.input, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8 },
  imgViewer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  imgClose: { position: 'absolute', right: 16, paddingHorizontal: 12, paddingVertical: 6 },
})
