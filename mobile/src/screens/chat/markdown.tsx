import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { lexer, type Token, type Tokens } from 'marked'
import { MONO, radius, type Palette } from '../../ui/tokens.ts'

// Markdown in Bot text: the marked lexer walks the block tokens; each block maps
// to RN views. Tables and fenced code scroll horizontally.
export function Markdown({ text, p, textColor, fontSize = 16, lineHeight = 24 }: { text: string; p: Palette; textColor: string; fontSize?: number; lineHeight?: number }) {
  const blocks = lexer(text)
  return <View>{blocks.map((token, index) => <Block key={index} token={token} p={p} textColor={textColor} fs={fontSize} lh={lineHeight} />)}</View>
}

function Block({ token, p, textColor, fs, lh }: { token: Token; p: Palette; textColor: string; fs: number; lh: number }) {
  const base = { color: textColor, fontSize: fs, lineHeight: lh }
  switch (token.type) {
    case 'heading': {
      const size = (token as Tokens.Heading).depth === 1 ? fs + 6 : (token as Tokens.Heading).depth === 2 ? fs + 3 : fs + 1
      return <Text selectable style={[base, { fontSize: size, fontWeight: '600', marginTop: 8, marginBottom: 4 }]}><Inlines tokens={(token as Tokens.Heading).tokens ?? []} p={p} color={textColor} /></Text>
    }
    case 'paragraph':
      return <Text selectable style={[base, { marginVertical: 4 }]}><Inlines tokens={(token as Tokens.Paragraph).tokens ?? []} p={p} color={textColor} /></Text>
    case 'code': {
      const code = (token as Tokens.Code)
      return (
        <View style={{ backgroundColor: p.hover, borderRadius: radius.item, marginVertical: 6, borderWidth: 1, borderColor: p.line }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
            <Text selectable style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : MONO, fontSize: 13, lineHeight: 19, color: textColor, paddingHorizontal: 10, paddingVertical: 8 }}>{code.text}</Text>
          </ScrollView>
        </View>
      )
    }
    case 'list': {
      const list = token as Tokens.List
      const depth = (token as Tokens.List & { depth?: number }).depth ?? 0
      // A list item's tokens are block tokens (text/paragraph, code, nested list).
      return (
        <View style={{ marginVertical: 4, marginLeft: depth * 14 }}>
          {list.items.map((item, index) => (
            <View key={index} style={{ flexDirection: 'row', marginVertical: 2 }}>
              <Text style={[base, { color: p.ink3, width: 22 }]}>{list.ordered ? `${(list.start as number) + index}.` : '•'}</Text>
              <View style={{ flex: 1 }}>{item.tokens?.map((inner, bi) => <Block key={bi} token={inner} p={p} textColor={textColor} fs={fs} lh={lh} />)}</View>
            </View>
          ))}
        </View>
      )
    }
    case 'blockquote':
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: p.line2, paddingLeft: 10, marginVertical: 6 }}>
          {(token as Tokens.Blockquote).tokens?.map((inner, index) => <Block key={index} token={inner} p={p} textColor={textColor} fs={fs} lh={lh} />)}
        </View>
      )
    case 'table': {
      const table = token as Tokens.Table
      const cells = (row: Tokens.TableCell[]) => row.map((cell, ci) => (
        <View key={ci} style={{ minWidth: 96, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: p.line }}>
          <Text selectable style={{ color: textColor, fontSize: fs - 1, lineHeight: lh - 3 }}><Inlines tokens={cell.tokens ?? []} p={p} color={textColor} /></Text>
        </View>
      ))
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6, flexGrow: 0 }}>
          <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.item }}>
            <View style={{ flexDirection: 'row', backgroundColor: p.hover }}>{cells(table.header)}</View>
            {table.rows.map((row, ri) => <View key={ri} style={{ flexDirection: 'row' }}>{cells(row)}</View>)}
          </View>
        </ScrollView>
      )
    }
    case 'hr':
      return <View style={{ height: 1, backgroundColor: p.line, marginVertical: 8 }} />
    case 'space':
      return <View style={{ height: 6 }} />
    case 'text': {
      const text = token as Tokens.Text
      return Array.isArray(text.tokens) && text.tokens.length > 0
        ? <Text selectable style={base}><Inlines tokens={text.tokens} p={p} color={textColor} /></Text>
        : <Text selectable style={base}>{text.text}</Text>
    }
    default:
      return 'raw' in token && typeof token.raw === 'string' && token.raw.trim() !== ''
        ? <Text selectable style={base}>{token.raw}</Text> : null
  }
}

function Inlines({ tokens, p, color }: { tokens: Token[]; p: Palette; color: string }) {
  return <>{tokens.map((token, index) => <Inline key={index} token={token} p={p} color={color} />)}</>
}

function Inline({ token, p, color }: { token: Token; p: Palette; color: string }): React.ReactNode {
  switch (token.type) {
    case 'strong':
      return <Text style={{ fontWeight: '600' }}><Inlines tokens={(token as Tokens.Strong).tokens ?? []} p={p} color={color} /></Text>
    case 'em':
      return <Text style={{ fontStyle: 'italic' }}><Inlines tokens={(token as Tokens.Em).tokens ?? []} p={p} color={color} /></Text>
    case 'codespan':
      return <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : MONO, fontSize: 14, backgroundColor: p.hover }}>{(token as Tokens.Codespan).text}</Text>
    case 'link': {
      const link = token as Tokens.Link
      // Bot text is untrusted: only web and mail links open; other schemes drop
      // to plain text so a crafted intent:/file: URL can never fire.
      const safe = /^https?:/i.test(link.href) || /^mailto:/i.test(link.href)
      if (!safe) return <Inlines tokens={link.tokens ?? []} p={p} color={color} />
      return (
        <Text style={{ color: p.accent, textDecorationLine: 'underline' }}
          onPress={() => void Linking.openURL(link.href).catch(() => {})}
          suppressHighlighting>
          <Inlines tokens={link.tokens ?? []} p={p} color={color} />
        </Text>
      )
    }
    case 'del':
      return <Text style={{ textDecorationLine: 'line-through' }}><Inlines tokens={(token as Tokens.Del).tokens ?? []} p={p} color={color} /></Text>
    case 'br':
      return '\n'
    case 'image':
      return <Text style={{ color: p.ink3 }}>{(token as Tokens.Image).text || 'image'}</Text>
    default:
      if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
        return <Inlines tokens={(token as { tokens: Token[] }).tokens} p={p} color={color} />
      }
      return 'text' in token ? String(token.text) : ('raw' in token ? String(token.raw) : null)
  }
}
