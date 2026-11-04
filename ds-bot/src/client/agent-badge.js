// The engine badge next to an abot's name: the route's original monogram, small.
import { createElement as h } from 'react'
import { inkFill } from './inks.js'
import { badgeOf } from './agent-routes.js'

export function AgentBadge({ engine, size = 15 }) {
  const badge = badgeOf(engine)
  if (badge === undefined) return null
  const [glyph, ink] = badge
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', className: 'bt-agent-badge',
    'aria-hidden': true,
    style: { color: inkFill(ink), flexShrink: 0, marginLeft: 4, verticalAlign: -2 },
  },
    h('rect', { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: 'currentColor', fillOpacity: 0.16, stroke: 'currentColor', strokeWidth: 1.4 }),
    h('text', { x: 10, y: 13.6, textAnchor: 'middle', fontSize: 7.5, fontWeight: 700, fill: 'currentColor', style: { letterSpacing: '0.02em' } }, glyph))
}
