// Where the Side App panel sits, as the user sees it: the three names, the menu in the
// panel's strip, and the rows in settings. The rule and the stored fields are in
// shared/side-layout.js; this only draws them and sends the user's choice.
import { createElement as h } from 'react'
import { DockedIcon, DrawerIcon, CenteredIcon } from './icons.js'
import { Segmented } from './motion.js'
import { DEFAULT_SIDE_LAYOUT, SIDE_LAYOUTS, effectiveSideLayout, isSideLayout } from '../shared/side-layout.js'
import { t } from './i18n.js'

export const LAYOUT_ICONS = { docked: DockedIcon, drawer: DrawerIcon, centered: CenteredIcon }

// Source strings are English; `t` finds the translation.
export const layoutName = layout => (layout === 'drawer' ? t('Drawer right') : layout === 'centered' ? t('Centered') : t('Docked right'))
export const layoutHint = layout => (layout === 'drawer'
  ? t('Slides over the right side of the chat without moving it.')
  : layout === 'centered' ? t('Floats in the middle of the window over the chat.') : t('Sits beside the chat and gives it less room.'))

/** The layout a Bot or group will draw its panel in, for a label. */
export const layoutOf = subject => effectiveSideLayout(subject)

/**
 * The layout of the panel that is open for `id` (a Bot, a group or one of their parts), for
 * the frame rules outside the panel: DSH's workspace view has no conversation behind it and
 * stays docked.
 */
export function panelLayoutOf(roster, id, view) {
  if (view === 'workspace') return 'docked'
  return effectiveSideLayout(roster?.byId?.[id] ?? roster?.roomsById?.[id])
}

/** The team default new conversations start with: the saved one, else docked. */
export const sideLayoutOf = prefs => (isSideLayout(prefs?.sideLayout) ? prefs.sideLayout : DEFAULT_SIDE_LAYOUT)

/** What the Reset entry returns to: the layout the conversation was made with, or docked. */
export const originalLayout = subject => (isSideLayout(subject?.sideLayoutInitial) ? subject.sideLayoutInitial : 'docked')

/** Whether the conversation has a choice of its own that Reset would remove. */
export const hasLayoutOverride = subject => isSideLayout(subject?.sideLayout)

/**
 * Menu entries for PanelMenu: the three layouts with the current one checked, then Reset
 * while the conversation has a choice of its own.
 */
export function layoutMenuItems(subject, setLayout) {
  const current = layoutOf(subject)
  const items = SIDE_LAYOUTS.map(id => ({
    key: `layout:${id}`, icon: LAYOUT_ICONS[id], label: layoutName(id), checked: id === current,
    onPick: () => { if (id !== current) setLayout(id) },
  }))
  if (hasLayoutOverride(subject)) {
    items.push({ sep: true })
    items.push({ key: 'layout:reset', icon: DockedIcon, label: t('Reset to original layout'), onPick: () => setLayout(null) })
  }
  return items
}

/** The three layouts as one segmented control, for a settings row. */
export function LayoutChoice({ label, value, onPick }) {
  return h(Segmented, { label, value, className: 'bt-look-seg' }, SIDE_LAYOUTS.map(id => h('button', {
    key: id, type: 'button', 'aria-pressed': value === id, onClick: () => { if (value !== id) onPick(id) },
  }, layoutName(id))))
}

/**
 * One Bot's or group's own choice, in its settings: the three layouts, what the current
 * one means, and Reset while the conversation has a choice of its own.
 */
export function SideLayoutCard({ subject, Card, run, setFlags }) {
  const current = layoutOf(subject)
  const save = sideLayout => run(setFlags(subject.id, { sideLayout }))
  return h(Card, { title: t('Side App layout') },
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h(LayoutChoice, { label: t('Side App layout'), value: current, onPick: save }),
      h('span', { key: current, className: 'bt-set-hint bt-veil' }, layoutHint(current))),
    hasLayoutOverride(subject)
      ? h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-set-hint' }, t('Made with {layout}.', { layout: layoutName(originalLayout(subject)) }))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => save(null) }, t('Reset to original layout')))
      : null)
}
