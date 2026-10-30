import { Image, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { characterMarkup, lookOf, MASK_ID, shapeOf } from '../../ds-bot/src/client/characters.js'
import { INKS } from '../../ds-bot/src/client/inks.js'

// The Bot's own mascot, drawn by the same generator as the desktop mark
// (ds-bot/src/client/characters.js). CSS ink variables resolve to the mode's
// color here instead of a stylesheet.

let serial = 0

export function botSvg(bot: unknown, dark: boolean): string {
  const look = lookOf(bot)
  const box = shapeOf(look.shape).size
  const id = `pm${serial += 1}`
  const inner = characterMarkup(look.shape, look.color).replaceAll(MASK_ID, id)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${inner}</svg>`
  const inks = INKS as Record<string, string[]>
  return svg.replace(/var\(--bt-ink-(\w+)\)/g, (_match, name: string) => (inks[name] ?? inks.gray)[dark ? 1 : 0])
}

export function BotMark({ bot, dark, size = 36 }: { bot: unknown; dark: boolean; size?: number }) {
  const look = lookOf(bot)
  if (typeof look.image === 'string' && look.image.startsWith('data:')) {
    return <Image source={{ uri: look.image }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  }
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={botSvg(bot, dark)} width={size} height={size} />
    </View>
  )
}
