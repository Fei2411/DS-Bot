// The engine badge next to an abot's name: the agent's own logo, small; a
// monogram only for agents that have none here.
import { createElement as h } from 'react'
import { inkFill } from './inks.js'
import { badgeOf, logoOf } from './agent-routes.js'

export function AgentBadge({ engine, size = 15 }) {
  const logo = logoOf(engine)
  const style = { flexShrink: 0, marginLeft: 4, verticalAlign: -2 }
  if (logo?.kind === 'image') {
    return h('img', { src: logo.src, width: size, height: size, alt: '', title: logo.title, className: 'bt-agent-badge', style: { ...style, borderRadius: 4 } })
  }
  if (logo?.kind === 'path') {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', className: 'bt-agent-badge', role: 'img', 'aria-label': logo.title, style: { ...style, color: `#${logo.hex}` } },
      h('title', null, logo.title), h('path', { d: logo.d, fill: 'currentColor' }))
  }
  const badge = badgeOf(engine)
  if (badge === undefined) return null
  const [glyph, ink] = badge
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', className: 'bt-agent-badge', 'aria-hidden': true,
    style: { ...style, color: inkFill(ink) },
  },
    h('rect', { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: 'currentColor', fillOpacity: 0.16, stroke: 'currentColor', strokeWidth: 1.4 }),
    h('text', { x: 10, y: 13.6, textAnchor: 'middle', fontSize: 7.5, fontWeight: 700, fill: 'currentColor' }, glyph))
}
