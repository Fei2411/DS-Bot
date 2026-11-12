import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { useRef, useState } from 'react'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { lexer, type Token, type Tokens } from 'marked'
import { MONO, radius, type Palette } from '../../ui/tokens.ts'

// Markdown in Bot text: the marked lexer walks the block tokens; each block maps
// to RN views. Tables and fenced code scroll horizontally.

// A chat redraws its rows on every refresh and a streamed reply on every token, so
// each text is lexed once and the tokens are kept for the most recent texts.
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
// table, heading, rule, quote) needs the bubble's full width to wrap inside it.
export function hasBlockContent(text: string): boolean {
  return text !== '' && tokensOf(text).some(token => token.type !== 'paragraph' && token.type !== 'text' && token.type !== 'space')
}

// Lines, code backgrounds and bullets are tints of the text color, so the same
// Markdown reads on the Bot's light bubble and on the user's dark one.
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (hex !== undefined) return `rgba(${[0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color)?.[1]?.split(',').slice(0, 3).join(',')
  return rgb !== undefined ? `rgba(${rgb},${alpha})` : color
}

interface Ink { text: string; muted: string; line: string; fill: string; bg: string }

export function Markdown({ text, p, textColor, bg, fontSize = 16, lineHeight = 25 }: { text: string; p: Palette; textColor: string; bg?: string; fontSize?: number; lineHeight?: number }) {
  const blocks = tokensOf(text).filter(token => token.type !== 'space')
  const ink: Ink = { text: textColor, muted: tint(textColor, 0.48), line: tint(textColor, 0.14), fill: tint(textColor, 0.07), bg: bg ?? p.bubble }
  return (
    <View>
      {blocks.map((token, index) => (
        <Block key={index} token={token} p={p} ink={ink} textColor={textColor} fs={fontSize} lh={lineHeight}
          first={index === 0} last={index === blocks.length - 1} />
      ))}
    </View>
  )
}

function Block({ token, p, ink, textColor, fs, lh, first = false, last = false }: { token: Token; p: Palette; ink: Ink; textColor: string; fs: number; lh: number; first?: boolean; last?: boolean }) {
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
    case 'paragraph':
      return (
        <Text selectable style={[base, { marginTop: top(8), marginBottom: bottom(2) }]}>
          <Inlines tokens={(token as Tokens.Paragraph).tokens ?? []} p={p} color={textColor} fs={fs} />
        </Text>
      )
    case 'code': {
      const code = (token as Tokens.Code)
      return (
        <View style={{ backgroundColor: ink.fill, borderRadius: radius.input, marginTop: top(6), marginBottom: bottom(6), borderWidth: 1, borderColor: ink.line, overflow: 'hidden' }}>
          <HScroll fade={ink.bg}>
            <Text selectable style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : MONO, fontSize: 13, lineHeight: 19, color: textColor, paddingHorizontal: 12, paddingVertical: 9 }}>{code.text}</Text>
          </HScroll>
        </View>
      )
    }
    case 'list': {
      const list = token as Tokens.List
      const depth = (token as Tokens.List & { depth?: number }).depth ?? 0
      // A list item's tokens are block tokens (text/paragraph, code, nested list).
      return (
        <View style={{ marginTop: top(6), marginBottom: bottom(4), marginLeft: depth * 14, gap: 6 }}>
          {list.items.map((item, index) => {
            const innerTokens = (item.tokens ?? []).filter(inner => inner.type !== 'space')
            return (
              <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <Text style={[base, { color: ink.muted, minWidth: list.ordered ? 24 : 16, paddingRight: list.ordered ? 6 : 4, fontVariant: ['tabular-nums'] }]}>
                  {list.ordered ? `${(list.start as number) + index}.` : '•'}
                </Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {innerTokens.map((inner, bi) => (
                    <Block key={bi} token={inner} p={p} ink={ink} textColor={textColor} fs={fs} lh={lh}
                      first={bi === 0} last={bi === innerTokens.length - 1} />
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
              first={index === 0} last={index === innerTokens.length - 1} />
          ))}
        </View>
      )
    }
    case 'table': {
      const table = token as Tokens.Table
      const cells = (row: Tokens.TableCell[], ri: number, header = false) => row.map((cell, ci) => (
        <View key={ci} style={{ minWidth: 92, maxWidth: 260, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: ri > 0 ? 1 : 0, borderTopColor: ink.line }}>
          <Text selectable style={{ color: textColor, fontSize: fs - 1, lineHeight: lh - 4, fontWeight: header ? '600' : '400' }}>
            <Inlines tokens={cell.tokens ?? []} p={p} color={textColor} fs={fs - 1} />
          </Text>
        </View>
      ))
      return (
        <View style={{ marginTop: top(6), marginBottom: bottom(6) }}>
          <HScroll fade={ink.bg}>
            <View style={{ borderWidth: 1, borderColor: ink.line, borderRadius: radius.input, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', backgroundColor: ink.fill }}>{cells(table.header, 0, true)}</View>
              {table.rows.map((row, ri) => <View key={ri} style={{ flexDirection: 'row' }}>{cells(row, ri + 1)}</View>)}
            </View>
          </HScroll>
        </View>
      )
    }
    case 'hr':
      return <View style={{ height: 1, backgroundColor: ink.line, marginTop: top(10), marginBottom: bottom(10) }} />
    case 'space':
      return null
    case 'text': {
      const text = token as Tokens.Text
      return Array.isArray(text.tokens) && text.tokens.length > 0
        ? <Text selectable style={base}><Inlines tokens={text.tokens} p={p} color={textColor} fs={fs} /></Text>
        : <Text selectable style={base}>{text.text}</Text>
    }
    default:
      return 'raw' in token && typeof token.raw === 'string' && token.raw.trim() !== ''
        ? <Text selectable style={base}>{token.raw}</Text> : null
  }
}

// A horizontal scroller whose right edge fades while content hides behind it.
// The fade ends in the color behind the block (the bubble it sits in). The scroller
// takes its children's height: a horizontal ScrollView left to grow would stretch
// the bubble it sits in to the height of the whole chat.
function HScroll({ children, fade: background }: { children: React.ReactNode; fade: string }) {
  const [fade, setFade] = useState(false)
  const layout = useRef({ width: 0, content: 0, x: 0 })
  const check = () => setFade(layout.current.content > layout.current.width + 1 && layout.current.x < layout.current.content - layout.current.width - 8)
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
        onLayout={e => { layout.current.width = e.nativeEvent.layout.width; check() }}
        onContentSizeChange={w => { layout.current.content = w; check() }}
        onScroll={e => { layout.current.x = e.nativeEvent.contentOffset.x; check() }}
        scrollEventThrottle={32}>
        {children}
      </ScrollView>
      {fade ? (
        <View style={{ position: 'absolute', top: 1, bottom: 1, right: 1, width: 28 }} pointerEvents="none">
          <Svg width={28} height="100%" preserveAspectRatio="none" viewBox="0 0 28 10">
            <Defs>
              <LinearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={background} stopOpacity="0" />
                <Stop offset="1" stopColor={background} stopOpacity="1" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="28" height="10" fill="url(#fade)" />
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
    case 'image':
      return <Text style={{ color: tint(color, 0.45) }}>{(token as Tokens.Image).text || 'image'}</Text>
    default:
      if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
        return <Inlines tokens={(token as { tokens: Token[] }).tokens} p={p} color={color} fs={fs} />
      }
      return 'text' in token ? String(token.text) : ('raw' in token ? String(token.raw) : null)
  }
}
