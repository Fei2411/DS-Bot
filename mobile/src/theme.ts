import { ACCENT_INKS, INKS, luminance } from '../../ds-bot/src/client/inks.js'

// The mobile palette derives from the same eight theme colors as the desktop team UI
// (ds-bot/src/client/themes.js): light and dark sets, accent, and the same way of
// picking text on the accent.

export interface ThemeMode {
  bg: string; sidebar: string; bubble: string; card: string
  text: string; user: string; userText: string; accent: string
}

export const THEMES: Record<string, { label: string; light: ThemeMode; dark: ThemeMode }> = {
  deepseek: {
    label: 'DeepSeek',
    light: { bg: '#fcfcfc', sidebar: '#f7f7f7', bubble: '#eeeeee', card: '#ffffff', text: '#141414', user: '#070707', userText: '#fcfcfc', accent: '#4d6bfe' },
    dark: { bg: '#141414', sidebar: '#1b1b1b', bubble: '#262626', card: '#1f1f1f', text: '#f2f2f2', user: '#f2f2f2', userText: '#141414', accent: '#5b7bff' },
  },
  mono: {
    label: 'Mono',
    light: { bg: '#ffffff', sidebar: '#f9f9f9', bubble: '#f0f0f0', card: '#ffffff', text: '#0d0d0d', user: '#0d0d0d', userText: '#ffffff', accent: '#0d0d0d' },
    dark: { bg: '#0f0f0f', sidebar: '#171717', bubble: '#242424', card: '#1c1c1c', text: '#f4f4f4', user: '#f4f4f4', userText: '#0f0f0f', accent: '#f4f4f4' },
  },
  paper: {
    label: 'Paper',
    light: { bg: '#faf9f5', sidebar: '#f3f0e8', bubble: '#ebe7dc', card: '#ffffff', text: '#1f1e1b', user: '#2b2a26', userText: '#faf9f5', accent: '#d97757' },
    dark: { bg: '#1f1e1b', sidebar: '#262521', bubble: '#34322d', card: '#2a2925', text: '#f3f0e8', user: '#f3f0e8', userText: '#1f1e1b', accent: '#e08a6d' },
  },
  moonlight: {
    label: 'Moonlight',
    light: { bg: '#f7f9fc', sidebar: '#eef2f8', bubble: '#e5ebf5', card: '#ffffff', text: '#121826', user: '#1e3a8a', userText: '#ffffff', accent: '#1e86ff' },
    dark: { bg: '#0b1020', sidebar: '#10172a', bubble: '#1a2340', card: '#141c33', text: '#e8edf7', user: '#3b6fd8', userText: '#ffffff', accent: '#4f9dff' },
  },
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
  const theme = THEMES[themeId ?? ''] ?? THEMES.deepseek
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

// A Bot's color, resolved the way names and marks do on the desktop: a named ink has
// a light and a dark value, a #rrggbb color is used as is.
export function inkColor(color: string | undefined, dark: boolean): string {
  if (color !== undefined && inks[color] !== undefined) return inks[color][dark ? 1 : 0]
  if (color !== undefined && /^#[0-9a-f]{6}$/i.test(color)) return color
  return inks.gray[dark ? 1 : 0]
}
