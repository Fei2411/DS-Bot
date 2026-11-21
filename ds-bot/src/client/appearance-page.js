// Settings → Appearance (docs/plans/2026-11-21-appearance.md): a live preview on top, then
// the theme, its colors, text, shape and density, the background, messages and the user
// stylesheet. A chat's own background is set from its Bot or group settings with the same
// background editor. The settings page hands in its own rows and controls.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { ACCENT_INKS, INKS } from './inks.js'
import { accentIn, BACKGROUND_STARTS, moveBasics, themesOf, effectsOf, flatWidthOf, layoutOf, thinkingShown, widthOf, MESSAGE_WIDTH } from './themes.js'
import { backgroundPaint, DEFAULT_APPEARANCE_CHANGE, leaveSafeAppearance, onSafeAppearance, pictureUrl, safeAppearance } from './appearance.js'
import { call } from './api.js'
import { BLUR, contrast, DENSITIES, DIM, FONT_SIZE, LINE_HEIGHT, MAX_BACKGROUND_BYTES, MAX_CSS, RADIUS, READABLE, readAppearance, readThemeFile, SURFACE, themeFile, utf8Length } from '../shared/appearance.js'
import { Segmented } from './motion.js'
import { t } from './i18n.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)
// The three colors most people change, then the rest of the theme's colors.
const BASIC_LABELS = { accent: 'Accent', bg: 'Background color', text: 'Text color' }
const MORE_LABELS = { sidebar: 'Sidebar', bubble: 'Bubble', card: 'Card', user: 'Your bubble', userText: 'Your bubble text' }
// Each text color and the surface it is read on.
const READ_ON = { text: 'bg', userText: 'user' }
const LAYOUTS = [['bubble', 'Bubble'], ['flat', 'Flat']]
const EFFECTS = [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'None']]
const MODES = [['light', 'Light mode'], ['dark', 'Dark mode'], ['system', 'System']]
const DENSITY_LABELS = { compact: 'Compact', standard: 'Standard', roomy: 'Roomy' }
const KINDS = [['none', 'None'], ['color', 'Color'], ['gradient', 'Gradient'], ['image', 'Picture']]
const FITS = [['cover', 'Fill'], ['contain', 'Fit'], ['tile', 'Tile']]

const isDark = () => typeof document?.body?.hasAttribute === 'function' && document.body.hasAttribute('data-ds-dark-theme')
// A DSH row as settings.js draws it carries its id (`data-item`).
const dshRowId = row => row?.props?.['data-item']
const newThemeId = () => `my-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// A value that saves once the control rests, like the accent and width sliders do; a
// change still waiting when the page closes is saved, not dropped. A change saves where it
// was made: the save of the moment of the pick, not one a later render brings (another
// theme picked meanwhile).
// A control that stays while what it edits changes (`scope`, another theme) saves its waiting
// change at once and shows the new value.
function useResting(value, save, delay = 350, scope = undefined) {
  const [shown, setShown] = useState(value)
  const pending = useRef(undefined)
  const timer = useRef(0)
  const flush = () => {
    clearTimeout(timer.current)
    const next = pending.current
    pending.current = undefined
    if (next !== undefined) next.save(next.value)
  }
  const scoped = useRef(scope)
  useEffect(() => {
    if (scoped.current !== scope) {
      scoped.current = scope
      flush()
    }
    if (pending.current === undefined) setShown(value)
  }, [value, scope])
  useEffect(() => flush, [])
  const pick = (next) => {
    setShown(next)
    pending.current = { value: next, save }
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
  }
  // Another control set the value: the change still waiting must not land after it.
  const cancel = () => {
    clearTimeout(timer.current)
    pending.current = undefined
  }
  return [shown, pick, cancel]
}

export function Slider({ label, value, min, max, step, format = String, save }) {
  const [shown, pick] = useResting(value, save)
  return h('div', { className: 'bt-range', style: { '--bt-fill': `${((shown - min) / (max - min)) * 100}%` } },
    h('input', { type: 'range', min, max, step, value: shown, 'aria-label': label, 'aria-valuetext': format(shown), onChange: event => pick(Number(event.target.value)) }),
    h('output', null, format(shown)))
}

function ColorField({ label, value, save, hint }) {
  const [shown, pick] = useResting(value, save)
  return h('label', { className: 'bt-look-color', title: label },
    h('input', { type: 'color', value: shown, 'aria-label': label, onChange: event => pick(event.target.value) }),
    h('span', null, label),
    hint ? h('span', { className: 'bt-look-warn' }, hint) : null)
}

// A color as a row's control: the swatch and its #rrggbb code, either one to change it.
const HEX = /^#?([0-9a-f]{6})$/i
function ColorInput({ label, value, save, hint, scope }) {
  const [shown, pick] = useResting(value, save, 350, scope)
  const [text, setText] = useState(value.toUpperCase())
  useEffect(() => setText(shown.toUpperCase()), [shown])
  const commit = () => {
    const match = HEX.exec(text.trim())
    if (match === null) { setText(shown.toUpperCase()); return }
    const next = `#${match[1].toLowerCase()}`
    if (next !== shown) pick(next)
  }
  return h('span', { className: 'bt-look-cin' },
    hint ? h('span', { className: 'bt-look-warn' }, hint) : null,
    h('input', { className: 'bt-input bt-look-hex', value: text, spellCheck: false, maxLength: 7, 'aria-label': `${label} #RRGGBB`, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() } }),
    h('input', { type: 'color', className: 'bt-look-well', value: shown, 'aria-label': label, onChange: event => pick(event.target.value) }))
}

// A small picture of the window: sidebar, the other side's bubble and yours, over the
// background. It reads the same variables as the page, so it changes with every edit.
function Preview({ background }) {
  const [, setLoaded] = useState(0)
  const paint = background === undefined ? undefined : backgroundPaint(background, id => pictureUrl(id, call, () => setLoaded(count => count + 1)))
  return h('div', { className: 'bt-look-preview', 'aria-hidden': true, style: paint ? { background: `linear-gradient(var(--bt-wash),var(--bt-wash)),${paint}` } : undefined, 'data-bg': paint ? '' : undefined },
    h('div', { className: 'bt-look-pside' }, h('i'), h('i'), h('i'), h('i')),
    h('div', { className: 'bt-look-pmain' },
      h('div', { className: 'bt-look-pbot' }, t('Here is the plan.')),
      h('div', { className: 'bt-look-pyou' }, t('Looks good, go ahead.')),
      h('div', { className: 'bt-look-pbot bt-look-pshort' }, t('On it.'))))
}

function ThemeCard({ id, theme, current, pick, children }) {
  const mode = isDark() ? theme.dark : theme.light
  return h('div', { className: 'bt-look-theme', 'data-on': id === current ? '' : undefined },
    h('button', { type: 'button', className: 'bt-look-swatch', 'aria-pressed': id === current, onClick: () => pick(id), style: { '--s': mode.sidebar, '--m': mode.bg, '--a': mode.accent, '--b': mode.bubble } },
      h('span'), h('span')),
    h('div', { className: 'bt-look-tname' }, h('span', null, theme.own ? theme.label : t(theme.label)), children))
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const readFile = (file, as) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(reader.error ?? new Error(t('The file could not be read')))
  if (as === 'text') reader.readAsText(file)
  else reader.readAsDataURL(file)
})

function OwnThemeActions({ id, theme, prefs, actions, run }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(theme.label)
  const save = themes => run(actions.setPrefs({ themes }))
  const exportTheme = async () => {
    const appearance = readAppearance(prefs.appearance)
    const image = appearance.background?.kind === 'image' ? (await call('background-picture', { id: appearance.background.image }))?.image : undefined
    download(`${theme.label}.ds-bot-theme.json`, JSON.stringify(themeFile(theme, appearance, image), null, 2))
  }
  if (renaming) {
    const done = () => {
      setRenaming(false)
      if (name.trim() !== '' && name.trim() !== theme.label) void save({ [id]: { ...theme, label: name.trim() } })
    }
    return h('input', { className: 'bt-input bt-look-rename', value: name, autoFocus: true, maxLength: 40, 'aria-label': t('Theme name'), onChange: event => setName(event.target.value), onBlur: done, onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur(); if (event.key === 'Escape') { setName(theme.label); setRenaming(false) } } })
  }
  return h('span', { className: 'bt-look-tacts' },
    h('button', { type: 'button', className: 'bt-look-tact', onClick: () => setRenaming(true) }, t('Rename')),
    h('button', { type: 'button', className: 'bt-look-tact', onClick: () => save({ [newThemeId()]: { ...theme, label: t('{name} copy', { name: theme.label }) } }) }, t('Duplicate')),
    h('button', { type: 'button', className: 'bt-look-tact', onClick: () => run(exportTheme()) }, t('Export')),
    h('button', { type: 'button', className: 'bt-look-tact', onClick: () => save({ [id]: null }) }, t('Delete')))
}

function ThemeSection({ prefs, actions, run, Section, Row, Choice, ownWindow, dshRows }) {
  const themes = themesOf(prefs)
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const appearance = readAppearance(prefs.appearance)
  const pick = id => run(actions.setPrefs({ theme: id }))
  const ownCount = Object.values(themes).filter(theme => theme.own).length
  const create = () => {
    const base = themes[current]
    return run(actions.setPrefs({ themes: { [newThemeId()]: { label: t('My theme {n}', { n: ownCount + 1 }), light: base.light, dark: base.dark } } }))
  }
  const importFile = async (file) => {
    const read = readThemeFile(await readFile(file, 'text'))
    const id = newThemeId()
    const change = { themes: { [id]: read.theme }, theme: id, appearance: read.appearance }
    if (read.image !== undefined && read.appearance.background?.kind === 'image') {
      const saved = await actions.addBackground(read.image)
      change.appearance = { ...read.appearance, background: { ...read.appearance.background, image: saved.id } }
    }
    await actions.setPrefs(change)
  }
  const [accent, pickAccent, dropAccent] = useResting(prefs.accent ?? themes.deepseek.light.accent, value => run(actions.setPrefs({ accent: value })))
  const custom = Boolean(prefs.accent) && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent)
  return h(Section, { title: t('Theme') },
    ownWindow ? h(Row, { label: t('Appearance') }, h(Choice, { label: t('Appearance'), value: appearance.mode ?? 'system', options: MODES, pick: id => run(actions.setPrefs({ appearance: { mode: id } })) })) : null,
    ownWindow ? null : dshRows.filter(row => dshRowId(row) === 'appearance'),
    h('div', { className: 'bt-look-themes' },
      Object.entries(themes).map(([id, theme]) => h(ThemeCard, { key: id, id, theme, current, pick },
        theme.own ? h(OwnThemeActions, { id, theme, prefs, actions, run }) : null)),
      h('div', { className: 'bt-look-theme bt-look-new' },
        h('button', { type: 'button', className: 'bt-look-tact', onClick: create }, t('New theme')),
        h('label', { className: 'bt-look-tact' }, t('Import…'),
          h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(importFile(file)) } })))),
    h(Row, { label: t('Accent'), hint: t('Unread marks, badges, and the brand mark.') },
      h('div', { className: 'bt-swatches' },
        h('button', { type: 'button', className: 'bt-swatch bt-swatch-default', title: t('Theme accent'), 'aria-label': t('Theme accent'), 'aria-pressed': !prefs.accent, onClick: () => { dropAccent(); return run(actions.setPrefs({ accent: null })) } }),
        ACCENT_INKS.map(ink => h('button', {
          key: ink, type: 'button', className: 'bt-swatch', title: t(capitalize(ink)), 'aria-label': t(capitalize(ink)), 'aria-pressed': prefs.accent === INKS[ink][0],
          style: { background: `var(--bt-ink-${ink})` }, onClick: () => { dropAccent(); return run(actions.setPrefs({ accent: INKS[ink][0] })) },
        })),
        h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': custom },
          h('input', { type: 'color', value: accent, 'aria-label': t('Custom accent'), onChange: event => pickAccent(event.target.value) })))))
}

// The colors of the theme in use, for one mode: accent, background and text first, the
// other surfaces following them (themes.js moveBasics); "More colors" sets each one. A
// built-in theme is copied into a theme of your own on the first change, so the built-in
// one stays as it is.
function ColorsSection({ prefs, actions, run, Section, Row, Choice }) {
  const themes = themesOf(prefs)
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const theme = themes[current]
  const [mode, setMode] = useState(isDark() ? 'dark' : 'light')
  const [more, setMore] = useState(false)
  // The copy a built-in theme's first change saves into, while that theme stays in use.
  const target = useRef(null)
  const live = useRef(current)
  live.current = current
  useEffect(() => { if (target.current?.id !== current) target.current = null }, [current])
  // Edits sent but not yet back from the host: the next edit starts from them, so two quick
  // edits of different colors both land.
  const draft = useRef(null)
  // The colors the basic ones move the others from, kept while only the basic colors
  // change: a background set before the text can pass close to it, and nothing is lost then.
  const basis = useRef(null)
  // A save is bound to the theme and mode of the render the change was made in.
  const save = (change, extra = {}) => {
    if (!theme.own && target.current?.from !== current) target.current = { from: current, id: newThemeId() }
    const id = theme.own ? current : target.current.id
    const base = draft.current?.id === id ? draft.current.theme : themesOf(prefs)[id] ?? theme
    const next = { label: theme.own ? base.label : t('{name} (mine)', { name: t(theme.label) }), light: { ...base.light }, dark: { ...base.dark } }
    next[mode] = change(next[mode], `${id}/${mode}`)
    draft.current = { id, theme: next }
    const settle = () => { if (draft.current?.theme === next) draft.current = null }
    // The copy is put in use only while its theme still is; another theme picked meanwhile stays.
    const use = !theme.own && (live.current === current || live.current === id) ? { theme: id } : {}
    return Promise.resolve(run(actions.setPrefs({ themes: { [id]: next }, ...use, ...extra }))).finally(settle)
  }
  const basic = key => (colors, color, where) => {
    if (basis.current?.where !== where) basis.current = { where, colors }
    return moveBasics(basis.current.colors, colors, { [key]: color })
  }
  const own = key => (colors, color) => {
    basis.current = null
    return { ...colors, [key]: color }
  }
  const colors = theme[mode]
  const field = (key, label, value, change, extra) => {
    const ratio = READ_ON[key] === undefined ? undefined : contrast(colors[key], colors[READ_ON[key]])
    const hint = ratio !== undefined && ratio < READABLE ? t('Hard to read · {ratio}:1', { ratio: ratio.toFixed(1) }) : undefined
    // Keyed by the color alone: the first change copies a built-in theme into your own, and
    // the fields must stay as they are then, or a color being typed in another one is lost.
    return h(Row, { key: `${mode}-${key}`, label: t(label) }, h(ColorInput, { label: t(label), value, scope: target.current?.id === current ? target.current.from : current, save: color => save((colors, where) => change(colors, color, where), extra), hint }))
  }
  return h(Section, { title: theme.own ? t('Colors · {name}', { name: theme.label }) : t('Colors'), action: h(Choice, { label: t('Colors'), value: mode, options: [['light', 'Light mode'], ['dark', 'Dark mode']], pick: setMode }) },
    theme.own ? null : h('div', { className: 'bt-look-note' }, t('Changing a color saves a theme of your own; {name} stays as it is.', { name: t(theme.label) })),
    // The accent here is the theme's; the team's accent above gives way to it.
    field('accent', BASIC_LABELS.accent, accentIn(theme, mode, prefs.accent), (colors, accent) => ({ ...colors, accent }), { accent: null }),
    field('bg', BASIC_LABELS.bg, colors.bg, basic('bg')),
    field('text', BASIC_LABELS.text, colors.text, basic('text')),
    more ? Object.entries(MORE_LABELS).map(([key, label]) => field(key, label, colors[key], own(key))) : null,
    h('button', { type: 'button', className: 'bt-look-more', 'aria-expanded': more, onClick: () => setMore(open => !open) }, more ? t('Fewer colors') : t('More colors')))
}

// Fonts on this computer, once the user opens the list: the browser asks before it tells.
function useLocalFonts() {
  const [fonts, setFonts] = useState(null)
  const load = () => {
    if (fonts !== null || typeof window.queryLocalFonts !== 'function') return
    setFonts([])
    window.queryLocalFonts().then(list => setFonts([...new Set(list.map(font => font.family))].sort((a, b) => a.localeCompare(b)))).catch(() => setFonts([]))
  }
  return [fonts ?? [], load]
}

function FontField({ label, value, save, fonts, load }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = () => { if (text.trim() !== (value ?? '')) save(text.trim() === '' ? null : text.trim()) }
  const list = `bt-fonts-${label.replace(/\W/g, '')}`
  return h(Fragment, null,
    h('input', { className: 'bt-input bt-look-font', list, value: text, placeholder: t('System default'), 'aria-label': label, onFocus: load, onChange: event => setText(event.target.value), onBlur: commit, onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() } }),
    h('datalist', { id: list }, fonts.map(font => h('option', { key: font, value: font }))))
}

// Fonts in both forms: DSH's documented font variables carry them into what DSH draws.
// Size and line height are DS Bot's in the desktop app; in DSH they are DSH's own rows.
function TextSection({ prefs, actions, run, Section, Row, ownWindow, dshRows }) {
  const appearance = readAppearance(prefs.appearance)
  const [fonts, load] = useLocalFonts()
  const set = change => run(actions.setPrefs({ appearance: change }))
  return h(Section, { title: t('Text') },
    h(Row, { label: t('Interface font') }, h(FontField, { label: t('Interface font'), value: appearance.uiFont, save: uiFont => set({ uiFont }), fonts, load })),
    h(Row, { label: t('Code font') }, h(FontField, { label: t('Code font'), value: appearance.codeFont, save: codeFont => set({ codeFont }), fonts, load })),
    ownWindow ? h(Row, { label: t('Font size') }, h(Slider, { label: t('Font size'), value: appearance.fontSize ?? FONT_SIZE.initial, min: FONT_SIZE.min, max: FONT_SIZE.max, step: 1, save: fontSize => set({ fontSize }) })) : null,
    ownWindow ? h(Row, { label: t('Line height') }, h(Slider, { label: t('Line height'), value: appearance.lineHeight ?? LINE_HEIGHT.initial, min: LINE_HEIGHT.min, max: LINE_HEIGHT.max, step: 0.05, format: value => value.toFixed(2), save: lineHeight => set({ lineHeight }) })) : null,
    ownWindow ? null : dshRows.filter(row => dshRowId(row) !== 'appearance'))
}

/**
 * The background editor, for the team and for one chat.
 * @param {{ value: object | undefined, save: (background: object | null) => unknown, actions: object, run: Function, Row: Function, Choice: Function }} props
 */
export function BackgroundEditor({ value, save, actions, run, Row, Choice }) {
  const kind = value?.kind ?? 'none'
  const common = { ...(value?.blur ? { blur: value.blur } : {}), ...(value?.dim ? { dim: value.dim } : {}), ...(value?.surface ? { surface: value.surface } : {}) }
  const [failure, setFailure] = useState('')
  const pickKind = (next) => {
    if (next === 'none') return save(null)
    if (next === 'color') return save({ kind: 'color', color: value?.color ?? BACKGROUND_STARTS.color[isDark() ? 'dark' : 'light'], ...common })
    if (next === 'gradient') return save({ kind: 'gradient', from: value?.from ?? BACKGROUND_STARTS.from, to: value?.to ?? BACKGROUND_STARTS.to, angle: value?.angle ?? 135, ...common })
    return undefined
  }
  const pickPicture = async (file) => {
    setFailure('')
    if (file.size > MAX_BACKGROUND_BYTES) { setFailure(t('The picture is too large: the limit is {mb} MB', { mb: MAX_BACKGROUND_BYTES / 1024 / 1024 })); return }
    const saved = await actions.addBackground(await readFile(file, 'url'))
    await save({ kind: 'image', image: saved.id, ...(value?.kind === 'image' && value.fit ? { fit: value.fit } : {}), ...common })
  }
  const set = change => save({ ...value, ...change })
  return h(Fragment, null,
    h('div', { className: 'bt-look-kinds' }, KINDS.map(([id, label]) => id === 'image'
      ? h('label', { key: id, className: 'bt-look-kind', 'data-on': kind === id ? '' : undefined, 'data-kind': id },
        h('span', null, t(label)),
        h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(pickPicture(file)) } }))
      : h('button', { key: id, type: 'button', className: 'bt-look-kind', 'aria-pressed': kind === id, 'data-on': kind === id ? '' : undefined, 'data-kind': id, onClick: () => pickKind(id) }, h('span', null, t(label))))),
    failure ? h('div', { className: 'bt-set-note', role: 'alert' }, failure) : null,
    kind === 'color' ? h(Row, { label: t('Color') }, h(ColorField, { label: t('Color'), value: value.color, save: color => set({ color }) })) : null,
    kind === 'gradient' ? h(Fragment, null,
      h(Row, { label: t('Colors') }, h('span', { className: 'bt-look-pair' }, h(ColorField, { label: t('Start color'), value: value.from, save: from => set({ from }) }), h(ColorField, { label: t('End color'), value: value.to, save: to => set({ to }) }))),
      h(Row, { label: t('Angle') }, h(Slider, { label: t('Angle'), value: value.angle ?? 180, min: 0, max: 359, step: 1, format: angle => `${angle}°`, save: angle => set({ angle }) }))) : null,
    kind === 'image' ? h(Row, { label: t('Fit') }, h(Choice, { label: t('Fit'), value: value.fit ?? 'cover', options: FITS, pick: fit => set({ fit }) })) : null,
    kind === 'image' ? h(Row, { label: t('Blur') }, h(Slider, { label: t('Blur'), value: value.blur ?? 0, min: BLUR.min, max: BLUR.max, step: 1, format: blur => `${blur} px`, save: blur => set({ blur }) })) : null,
    kind === 'none' ? null : h(Row, { label: t('Dim') }, h(Slider, { label: t('Dim'), value: value.dim ?? 0, min: DIM.min, max: DIM.max, step: 5, format: dim => `${dim}%`, save: dim => set({ dim }) })),
    kind === 'none' ? null : h(Row, { label: t('Surface opacity') }, h(Slider, { label: t('Surface opacity'), value: value.surface ?? SURFACE.initial, min: SURFACE.min, max: SURFACE.max, step: 2, format: surface => `${surface}%`, save: surface => set({ surface }) })))
}

// "Restore default appearance" asks twice: the first click arms it for a few seconds.
function RestoreButton({ restore }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-armed': armed ? '' : undefined, onClick: () => { if (armed) { setArmed(false); restore() } else setArmed(true) } }, armed ? t('Click again to restore') : t('Restore'))
}

function StylesheetField({ value, save }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const size = utf8Length(text)
  return h('div', { className: 'bt-look-css' },
    h('textarea', { className: 'bt-input', spellCheck: false, value: text, rows: 6, placeholder: '.bt-row-title { letter-spacing: .02em }', 'aria-label': t('Your stylesheet'), onChange: event => setText(event.target.value), onBlur: () => { if (text !== (value ?? '') && size <= MAX_CSS) save(text === '' ? null : text) } }),
    size > MAX_CSS ? h('div', { className: 'bt-set-note', role: 'alert' }, t('The stylesheet holds at most {kb} KB', { kb: MAX_CSS / 1024 })) : null)
}

/**
 * @param {object} props
 * @param {boolean} props.ownWindow - the desktop app's own window: it owns light or dark, fonts and window material
 * @param {Array<import('react').ReactElement>} props.dshRows - DSH's own appearance rows (light or dark, font size), keyed by id; DSH only
 */
export function AppearancePage({ roster, actions, run, Section, Row, Choice, Switch, ownWindow, dshRows = [] }) {
  const prefs = roster.prefs ?? {}
  const appearance = readAppearance(prefs.appearance)
  const set = change => run(actions.setPrefs({ appearance: change }))
  const [safe, setSafe] = useState(safeAppearance)
  useEffect(() => onSafeAppearance(setSafe), [])
  return [
    safe ? h('div', { key: 'safe', className: 'bt-look-note bt-look-safe', role: 'status' },
      t('This window opened in safe appearance: the background and your stylesheet are off here.'), ' ',
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: leaveSafeAppearance }, t('Turn them back on'))) : null,
    h(Preview, { key: 'preview', background: safe ? undefined : appearance.background }),
    h(ThemeSection, { key: 'theme', prefs, actions, run, Section, Row, Choice, ownWindow, dshRows }),
    h(ColorsSection, { key: 'colors', prefs, actions, run, Section, Row, Choice }),
    h(TextSection, { key: 'text', prefs, actions, run, Section, Row, ownWindow, dshRows }),
    h(Section, { key: 'shape', title: t('Shape and density') },
      h(Row, { label: t('Corners') }, h(Slider, { label: t('Corners'), value: appearance.radius ?? RADIUS.initial, min: RADIUS.min, max: RADIUS.max, step: RADIUS.step, format: radius => `${radius}%`, save: radius => set({ radius }) })),
      h(Row, { label: t('Density') }, h(Choice, { label: t('Density'), value: appearance.density ?? 'standard', options: DENSITIES.map(id => [id, DENSITY_LABELS[id]]), pick: density => set({ density }) }))),
    h(Section, { key: 'background', title: t('Window background') },
      h(BackgroundEditor, { value: appearance.background, save: background => set({ background }), actions, run, Row, Choice }),
      // The window material switch comes with the desktop window's own frame (docs/plans/2026-11-21-own-frontend.md).
    ),
    h(Section, { key: 'messages', title: t('Messages') },
      h(Row, { label: t('Message layout') }, h(Choice, { label: t('Message layout'), value: layoutOf(prefs), options: LAYOUTS, pick: id => run(actions.setPrefs({ layout: id })) })),
      layoutOf(prefs) === 'flat' ? h(Row, { label: t('Text width') }, h(Slider, { label: t('Text width'), value: flatWidthOf(prefs), ...MESSAGE_WIDTH, format: width => `${width}%`, save: flatWidth => run(actions.setPrefs({ flatWidth })) })) : null,
      h(Row, { label: t('Bubble width') }, h(Slider, { label: t('Bubble width'), value: widthOf(prefs), ...MESSAGE_WIDTH, format: width => `${width}%`, save: width => run(actions.setPrefs({ width })) })),
      h(Row, { label: t('Interface motion') }, h(Choice, { label: t('Interface motion'), value: effectsOf(prefs), options: EFFECTS, pick: id => run(actions.setPrefs({ effects: id })) })),
      h(Row, { label: t('Show thinking') }, h(Switch, { label: t('Show thinking'), on: thinkingShown(prefs), onChange: thinking => run(actions.setPrefs({ thinking })) }))),
    h(Section, { key: 'advanced', title: t('Advanced') },
      h(Row, { label: t('Your stylesheet'), hint: t('Loaded last, after every other style. Hold Shift while the window opens to start without it.') }),
      h(StylesheetField, { value: appearance.css, save: css => set({ css }) }),
      h(Row, { label: t('Restore default appearance'), hint: t('Your own themes stay.') }, h(RestoreButton, { restore: () => run(actions.setPrefs(DEFAULT_APPEARANCE_CHANGE)) }))),
  ]
}

// Rows and choices for a form that has none of its own (the Bot and group forms' rows are
// labels, and the editor's color fields are labels too).
function PlainRow({ label, hint, children }) {
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)
}
function PlainChoice({ label, value, options, pick }) {
  return h(Segmented, { label, value, className: 'bt-look-seg' }, options.map(([id, text]) => h('button', {
    key: id, type: 'button', 'aria-pressed': value === id,
    onClick: () => { if (value !== id) pick(id) },
  }, t(text))))
}

/** A chat's own background, in its Bot or group settings. */
export function ChatBackgroundSection({ owner, ownerKind, actions, run, Section, Row = PlainRow, Choice = PlainChoice }) {
  const save = background => run(actions.setChatBackground({ [ownerKind === 'room' ? 'roomId' : 'botId']: owner.id, background }))
  return h(Section, { title: t('Chat background') },
    h('div', { className: 'bt-look-note' }, owner.background ? t('While this chat is open, its background takes the place of the team background.') : t('This chat uses the team background.')),
    h(BackgroundEditor, { value: readAppearance({ background: owner.background }).background, save, actions, run, Row, Choice }))
}

// Colors from the --bt-* variables only; corners on the standard steps.
export const APPEARANCE_PAGE_CSS = `
.bt-look-preview{position:relative;flex:none;height:150px;margin:0 0 18px;border-radius:16px;overflow:hidden;background:var(--bt-main);border:.5px solid var(--bt-line-2)}
.bt-look-pside{position:absolute;inset:12px auto 12px 12px;width:28%;display:flex;flex-direction:column;gap:7px;padding:10px;border-radius:12px;background:var(--bt-sidebar);box-sizing:border-box}
.bt-look-pside i{height:12px;border-radius:999px;background:var(--bt-line-2)}
.bt-look-pside i:first-child{background:var(--bt-active)}
.bt-look-pmain{position:absolute;inset:12px 12px 12px calc(28% + 22px);display:flex;flex-direction:column;justify-content:flex-end;gap:7px;padding:12px;border-radius:12px;background:var(--bt-main);box-sizing:border-box}
.bt-look-preview[data-bg] .bt-look-pmain{background:var(--bt-pane,var(--bt-main))}
.bt-look-preview[data-bg] .bt-look-pside{background:var(--bt-sidebar)}
.bt-look-pbot,.bt-look-pyou{max-width:70%;padding:6px 12px;border-radius:18px;font-size:12px;line-height:16px}
.bt-look-pbot{align-self:flex-start;background:var(--bt-bubble);color:var(--bt-ink)}
.bt-look-pyou{align-self:flex-end;background:var(--bt-user);color:var(--bt-user-ink)}
.bt-look-themes{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;padding:12px 16px}
.bt-look-theme{display:flex;flex-direction:column;border:.5px solid var(--bt-line-2);border-radius:12px;overflow:hidden;background:var(--bt-card)}
.bt-look-theme[data-on]{border-color:var(--bt-accent);box-shadow:0 0 0 1px var(--bt-accent)}
.bt-look-swatch{display:grid;grid-template-columns:30% 1fr;height:52px;padding:0;border:0;cursor:pointer;background:none}
.bt-look-swatch span:first-child{background:var(--s)}
.bt-look-swatch span:last-child{position:relative;background:var(--m)}
.bt-look-swatch span:last-child::before{content:"";position:absolute;left:8px;top:9px;width:44%;height:10px;border-radius:999px;background:var(--b)}
.bt-look-swatch span:last-child::after{content:"";position:absolute;right:8px;bottom:9px;width:28%;height:10px;border-radius:999px;background:var(--a)}
.bt-look-tname{display:flex;flex-direction:column;gap:2px;padding:6px 8px;font-size:12px;line-height:16px;color:var(--bt-ink)}
.bt-look-tacts{display:flex;flex-wrap:wrap;gap:2px 8px}
.bt-look-tact{padding:0;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.bt-look-tact:hover{color:var(--bt-ink)}
.bt-look-new{align-items:center;justify-content:center;gap:6px;min-height:78px;border-style:dashed;background:none}
.bt-look-new .bt-look-tact{font-size:12px}
.bt-look-rename{height:24px;font-size:12px;padding:0 6px}
.bt-look-color{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;color:var(--bt-ink);cursor:pointer;flex-wrap:wrap}
.bt-look-color input{width:24px;height:24px;padding:0;border:.5px solid var(--bt-line-2);border-radius:6px;background:none;cursor:pointer}
.bt-look-color input::-webkit-color-swatch-wrapper{padding:0}
.bt-look-color input::-webkit-color-swatch{border:0;border-radius:6px}
.bt-look-warn{flex-basis:100%;padding-left:32px;color:var(--bt-warn);font-size:11px}
.bt-look-pair{display:flex;gap:16px}
.bt-look-cin{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-look-cin .bt-look-warn{flex-basis:auto;padding:0}
.bt-look-hex{width:92px;height:28px;padding:0 8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;text-transform:uppercase}
.bt-look-well{width:28px;height:28px;padding:0;border:.5px solid var(--bt-line-2);border-radius:8px;background:none;cursor:pointer}
.bt-look-well::-webkit-color-swatch-wrapper{padding:0}
.bt-look-well::-webkit-color-swatch{border:0;border-radius:8px}
.bt-look-more{align-self:flex-start;margin:4px 16px 10px;padding:0;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.bt-look-more:hover{color:var(--bt-ink)}
.bt-look-font{width:216px}
.bt-look-kinds{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px 16px 4px}
.bt-look-kind{display:flex;align-items:flex-end;height:54px;padding:6px 8px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;box-sizing:border-box}
.bt-look-kind[data-kind=color]{background:var(--bt-bubble)}
.bt-look-kind[data-kind=gradient]{background:linear-gradient(135deg,var(--bt-accent),var(--bt-bubble))}
.bt-look-kind[data-kind=image]{background:linear-gradient(160deg,var(--bt-ink-3),var(--bt-active))}
.bt-look-kind[data-kind=gradient] span,.bt-look-kind[data-kind=image] span{padding:1px 6px;border-radius:999px;background:var(--bt-card);color:var(--bt-ink)}
.bt-look-kind[data-on]{border-color:var(--bt-accent);box-shadow:0 0 0 1px var(--bt-accent)}
.bt-look-css{padding:0 16px 12px}
.bt-look-css textarea{height:auto;min-height:96px;padding:8px 11px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;resize:vertical}
.bt-look-note{padding:10px 16px 0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-look-safe{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
button[data-armed]{color:var(--bt-warn)}
`
