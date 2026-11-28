import { lookOf, maskOf } from '../../../ds-bot/src/client/characters.js'
import { inkText, paintCss } from '../../../ds-bot/src/client/inks.js'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'

export function mentionStyles(bots) {
  return bots.map(bot => {
    const anchor = `.bt-bubble a[href=${JSON.stringify(MENTION_ORIGIN + bot.id)}]`
    const { image, shape, color } = lookOf(bot)
    const mark = image
      ? `background:center/cover url(${JSON.stringify(image)});-webkit-mask:none;mask:none;border-radius:50%`
      : `background:${paintCss(color)};-webkit-mask-image:${maskOf(shape)};mask-image:${maskOf(shape)}`
    return `${anchor}{color:${inkText(color)}}${anchor}::before{${mark}}`
  }).join('\n')
}
