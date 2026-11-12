import { createContext, useContext } from 'react'
import { allThemes } from '../../../ds-bot/src/client/themes.js'
import { ACCENT_INKS, INKS, luminance } from '../../../ds-bot/src/client/inks.js'

// The phone palette derives from the same eight theme colors as the desktop team
// UI (ds-bot/src/client/themes.js), through allThemes() so custom themes follow too.

export interface ThemeMode {
  bg: string; sidebar: string; bubble: string; card: string
  text: string; user: string; userText: string; accent: string
}

const DARK_INK = '#141414'
const accentInk = (accent: string) =>
  (luminance(accent) + 0.05) ** 2 > 1.05 * (luminance(DARK_INK) + 0.05) ? DARK_INK : '#ffffff'
const rgba = (hex: string, alpha: number) =>
  `rgba(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`

const inks = INKS as Record<string, string[]>

// A preset accent is saved as its light value; in dark mode it takes the preset's dark
// value, like Bot names. A custom accent is the same in both modes.
const darkAccent = (accent: string): string => {
  const ink = ACCENT_INKS.find(id => inks[id][0] === accent)
  return ink === undefined ? accent : inks[ink][1]
}

export interface Palette {
  ink: string; ink2: string; ink3: string
  bubble: string; sidebar: string; main: string; card: string
  line: string; line2: string; lineWeak: string
  hover: string; active: string
  accent: string; accentInk: string
  user: string; userInk: string
  tagBg: string; tagInk: string
  danger: string; green: string; star: string
}

export function palette(dark: boolean, themeId?: string, accent?: string): Palette {
  const themes = allThemes() as Record<string, { label: string; light: ThemeMode; dark: ThemeMode }>
  const theme = themes[themeId ?? ''] ?? themes.deepseek
  const mode = dark ? theme.dark : theme.light
  const use = accent === undefined ? mode.accent : dark ? darkAccent(accent) : accent
  return {
    ink: mode.text, ink2: rgba(mode.text, 0.6), ink3: rgba(mode.text, 0.36),
    bubble: mode.bubble, sidebar: mode.sidebar, main: mode.bg, card: mode.card,
    line: rgba(mode.text, 0.08), line2: rgba(mode.text, 0.15), lineWeak: rgba(mode.text, 0.1),
    hover: dark ? 'rgba(160,160,160,.12)' : 'rgba(119,119,119,.09)',
    active: dark ? 'rgba(160,160,160,.2)' : 'rgba(119,119,119,.17)',
    accent: use, accentInk: accentInk(use),
    user: mode.user, userInk: mode.userText,
    tagBg: rgba(mode.text, dark ? 0.09 : 0.06), tagInk: rgba(mode.text, 0.58),
    danger: '#e02135', green: '#00c972', star: '#ff9800',
  }
}

export function themeLabel(themeId?: string): string {
  const themes = allThemes() as Record<string, { label: string }>
  return themes[themeId ?? '']?.label ?? themes.deepseek.label
}

// A Bot's color, resolved the way names and marks do on the desktop: a named ink has
// a light and a dark value, a #rrggbb color is used as is.
export function inkColor(color: string | undefined, dark: boolean): string {
  if (color !== undefined && inks[color] !== undefined) return inks[color][dark ? 1 : 0]
  if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) return color
  return inks.gray[dark ? 1 : 0]
}

// The 9.1 springs as Reanimated configs: stiffness = w^2, damping = 2*zeta*w, mass 1.
export const springOf = (w: number, z: number) => ({ mass: 1, stiffness: w * w, damping: 2 * z * w })
export const SPRING_SHAPE = springOf(20, 0.78)
export const SPRING_TAP = springOf(30, 0.8)
export const SPRING_LIST = springOf(22, 0.8)
export const SPRING_STRETCH = springOf(18, 0.56)
export const SPRING_POP = springOf(22, 0.49)

// Phone type scale: settled sizes for touch, weights only 400/500/600.
export const type = {
  rowName: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  rowPreview: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  bubble: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  headerTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: '600' as const },
  settingsRow: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const },
}

export const radius = { tag: 4, item: 6, input: 8, row: 10, card: 12, option: 12, dialog: 16, bubble: 18, composer: 22, composerLong: 18, pill: 999 }

// Shadow levels 0-4 from the standard, mapped to iOS shadow + Android elevation.
export const shadow = (level: 0 | 1 | 2 | 3 | 4, color = '#000') => ([
  {},
  { shadowColor: color, shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.06, elevation: 3 },
  { shadowColor: color, shadowOffset: { width: 0, height: 10 }, shadowRadius: 20, shadowOpacity: 0.1, elevation: 8 },
  { shadowColor: color, shadowOffset: { width: 0, height: 8 }, shadowRadius: 28, shadowOpacity: 0.14, elevation: 12 },
  { shadowColor: color, shadowOffset: { width: 0, height: 24 }, shadowRadius: 80, shadowOpacity: 0.24, elevation: 16 },
][level])

export const MONO = 'monospace'

export interface Theme { dark: boolean; p: Palette }
export const ThemeContext = createContext<Theme>({ dark: false, p: palette(false) })
export const useTheme = () => useContext(ThemeContext)
