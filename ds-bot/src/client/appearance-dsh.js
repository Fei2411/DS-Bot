// Plugin-only appearance CSS bridge: mirrors DS Bot's typography settings onto
// DSH's `--dsh-font-family-*` and `--dsh-content-font-size` custom properties.
// Never imported by the desktop app (`app/ui/src/main.js`).
import { fontStack, readAppearance } from '../shared/appearance.js'

export function dshAppearanceCss({ appearance, fonts = false } = {}) {
  const look = readAppearance(appearance)
  const vars = []
  if (look.uiFont) vars.push(`--dsh-font-family-text:${fontStack(look.uiFont)}`)
  if (look.codeFont) vars.push(`--dsh-font-family-code:${fontStack(look.codeFont)}`)
  if (fonts && look.fontSize) vars.push(`--dsh-content-font-size:${look.fontSize}px`)
  return vars.length > 0 ? `html body{${vars.join(';')}}` : ''
}
