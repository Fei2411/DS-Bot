// Official browser marks for Cookie Import. Each mark identifies a third-party
// browser installed on the user's machine (see NOTICE). Uses unique per-mount
// SVG gradient IDs via a module counter so multiple profiles of the same browser
// never collide in the DOM.
import { createElement as h, useState } from 'react'

let nextGradId = 0
function useGradPrefix(tag) {
  return useState(() => `bt-bm-${tag}-${++nextGradId}`)[0]
}

const wrap = (size, children, viewBox = '0 0 24 24') => h('svg', {
  width: size, height: size, viewBox, fill: 'none', 'aria-hidden': true,
}, ...children)

// Google Chrome: exact 120-degree 4-color wheel (2022 flat geometry, zero IDs).
function ChromeMark({ size, colors }) {
  const [top, right, left, core] = colors
  return wrap(size, [
    h('path', { key: 't', d: 'M3.51 7.1A9.8 9.8 0 0 1 20.49 7.1H12a4.9 4.9 0 0 0-4.24 7.35Z', fill: top }),
    h('path', { key: 'r', d: 'M20.49 7.1A9.8 9.8 0 0 1 12 21.8l4.24-7.35A4.9 4.9 0 0 0 12 7.1Z', fill: right }),
    h('path', { key: 'l', d: 'M12 21.8A9.8 9.8 0 0 1 3.51 7.1l4.25 7.35a4.9 4.9 0 0 0 8.48 0Z', fill: left }),
    h('circle', { key: 'w', cx: 12, cy: 12, r: 5.05, fill: '#FFFFFF' }),
    h('circle', { key: 'c', cx: 12, cy: 12, r: 3.9, fill: core }),
  ])
}

const CHROME_PALETTES = {
  chrome: ['#EA4335', '#FBBC04', '#34A853', '#4285F4'],
  canary: ['#E37400', '#F9AB00', '#FDD663', '#F29900'],
  chromium: ['#396BD7', '#6199F6', '#A8C7FA', '#4285F4'],
}

// Apple Safari: sky-to-cobalt circular dial, subtle degree ticks, 45-degree red/white needle.
const SAFARI_TICKS = Array.from({ length: 16 }, (_, i) => {
  const a = (i * Math.PI) / 8
  const major = i % 2 === 0
  const r1 = major ? 7.35 : 7.9
  const r2 = 8.95
  return {
    key: i,
    x1: (12 + r1 * Math.cos(a)).toFixed(2),
    y1: (12 + r1 * Math.sin(a)).toFixed(2),
    x2: (12 + r2 * Math.cos(a)).toFixed(2),
    y2: (12 + r2 * Math.sin(a)).toFixed(2),
    opacity: major ? 0.85 : 0.45,
  }
})

function SafariMark({ size }) {
  const id = useGradPrefix('saf')
  return wrap(size, [
    h('defs', { key: 'd' },
      h('linearGradient', { id, x1: '12', y1: '2', x2: '12', y2: '22', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#2AC6FF' }),
        h('stop', { offset: '100%', stopColor: '#1B6CE5' }))),
    h('circle', { key: 'bg', cx: 12, cy: 12, r: 10, fill: `url(#${id})` }),
    ...SAFARI_TICKS.map((t) => h('line', {
      key: `t${t.key}`, x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2,
      stroke: '#FFFFFF', strokeWidth: 0.75, strokeLinecap: 'round', strokeOpacity: t.opacity,
    })),
    h('polygon', { key: 'n1', points: '10.45,10.45 17.55,6.45 13.55,13.55', fill: '#FF3B30' }),
    h('polygon', { key: 'n2', points: '10.45,10.45 6.45,17.55 13.55,13.55', fill: '#FFFFFF' }),
    h('circle', { key: 'p', cx: 12, cy: 12, r: 0.85, fill: '#E5E7EB' }),
  ])
}

// Microsoft Edge: swirling blue-teal-mint wave mark.
function EdgeMark({ size }) {
  const id = useGradPrefix('edg')
  const g1 = `${id}-1`
  const g2 = `${id}-2`
  const g3 = `${id}-3`
  return wrap(size, [
    h('defs', { key: 'd' },
      h('linearGradient', { id: g1, x1: '4', y1: '16', x2: '20', y2: '16', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#0C59A4' }),
        h('stop', { offset: '100%', stopColor: '#114A8B' })),
      h('radialGradient', { id: g2, cx: '9', cy: '14', r: '10', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#1B9DE2' }),
        h('stop', { offset: '100%', stopColor: '#0078D4' })),
      h('linearGradient', { id: g3, x1: '5', y1: '3', x2: '21', y2: '14', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#35C1F1' }),
        h('stop', { offset: '55%', stopColor: '#25B8E6' }),
        h('stop', { offset: '100%', stopColor: '#4EE09B' }))),
    // Bottom navy curl
    h('path', {
      key: 'b',
      d: 'M20.6 16.5A9.9 9.9 0 0 1 6.3 20.1c2.4 1.1 5.6 1.1 8.3-.2 2.4-1.1 4.2-2.7 6-3.4Z',
      fill: `url(#${g1})`,
    }),
    // Left azure body
    h('path', {
      key: 'l',
      d: 'M11.6 2.1A9.9 9.9 0 0 0 2.1 12a9.9 9.9 0 0 0 9.9 9.9c2.7 0 5.3-1.1 7.1-2.9-2.8 1-5.8.7-8.1-.9-2.2-1.5-3.4-4-3.1-6.5.2-1.8 1.2-3.4 2.7-4.4 1.2-.8 2.8-1 4.1-.5-.9-2.5-3.1-4.6-3.1-4.6Z',
      fill: `url(#${g2})`,
    }),
    // Top-right mint-cyan wave crest
    h('path', {
      key: 't',
      d: 'M12 2.1c5.1 0 9.4 3.8 9.9 8.8.1 1.2-.1 2.5-.7 3.5-1.4 2.4-4.7 3-7.3 2-1.8-.7-3.1-2.1-3.3-3.7-.2-1.3.4-2.6 1.5-3.2 1.1-.6 2.6-.4 3.4.5.4.5.6 1.1.5 1.8.8-.8 1.1-2 .7-3.2-.6-1.9-2.4-3.3-4.6-3.4-2.5-.1-4.9 1.3-6.1 3.5C7 5 9.3 2.1 12 2.1Z',
      fill: `url(#${g3})`,
    }),
  ])
}

// Mozilla Firefox: deep indigo-violet globe embraced by fiery orange-gold fox flame.
function FirefoxMark({ size }) {
  const id = useGradPrefix('ffx')
  const gGlobe = `${id}-g`
  const gTail = `${id}-t`
  const gCrest = `${id}-c`
  return wrap(size, [
    h('defs', { key: 'd' },
      h('radialGradient', { id: gGlobe, cx: '14', cy: '10', r: '8', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#9059FF' }),
        h('stop', { offset: '60%', stopColor: '#5B2C91' }),
        h('stop', { offset: '100%', stopColor: '#312A75' })),
      h('linearGradient', { id: gTail, x1: '20', y1: '4', x2: '5', y2: '21', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#FFD60A' }),
        h('stop', { offset: '48%', stopColor: '#FF8A00' }),
        h('stop', { offset: '100%', stopColor: '#FF2D55' })),
      h('linearGradient', { id: gCrest, x1: '18', y1: '3', x2: '10', y2: '13', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#FFF066' }),
        h('stop', { offset: '100%', stopColor: '#FF7A00' }))),
    h('circle', { key: 'g', cx: 12.2, cy: 12.4, r: 6.1, fill: `url(#${gGlobe})` }),
    h('path', {
      key: 'f',
      d: 'M20.6 7.5c-.5-1.1-1.6-2.4-2.5-2.9.7 1.3 1 2.7.9 4.1-.3-1.2-1.1-2.5-2.3-3.4-1.3-1-2.6-1.3-3.6-1.4 1.6.9 2.2 2.4 2.1 3.7-.7-.4-1.7-.5-2.6-.2-1.8.6-3 2.3-2.9 4.2.1 2.1 1.7 3.7 3.8 3.9 1.6.1 3.1-.6 3.9-1.9-.6 2.1-2.4 3.7-4.8 3.8-3 .2-5.7-2-6-5-.2-2 .7-4 2.3-5.2-.9-.1-1.9.1-2.8.6.5-1.4 1.5-2.7 2.8-3.5-2.5.4-4.7 2-5.9 4.3A9.8 9.8 0 0 0 12 22c5.4 0 9.8-4.4 9.8-9.8 0-1.7-.4-3.3-1.2-4.7Z',
      fill: `url(#${gTail})`,
    }),
    h('path', {
      key: 'c',
      d: 'M17.8 4.4c1.5 1.3 2.5 3.1 2.8 5.2-1-2.1-2.8-3.4-5.1-3.7 1-.7 1.8-1.1 2.3-1.5Z',
      fill: `url(#${gCrest})`,
    }),
  ])
}

// Brave: iconic orange-vermilion lion shield.
function BraveMark({ size }) {
  const id = useGradPrefix('brv')
  return wrap(size, [
    h('defs', { key: 'd' },
      h('linearGradient', { id, x1: '12', y1: '2', x2: '12', y2: '22', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: '#FF7629' }),
        h('stop', { offset: '100%', stopColor: '#F3391E' }))),
    h('path', {
      key: 's',
      d: 'M12 2.4 18.8 5l1.1 2.3-1.1 1.7.8 2.4-2.2 6.8L12 21.8l-5.4-3.6-2.2-6.8.8-2.4-1.1-1.7L5.2 5 12 2.4Z',
      fill: `url(#${id})`,
    }),
    h('path', {
      key: 'f',
      d: 'M12 6.5 8.1 8.4l.9 2.3 1.7-.7-.4 2.1 1.7 1.3 1.7-1.3-.4-2.1 1.7.7.9-2.3L12 6.5Zm0 8.5-2.6-1.4.8 3.2L12 18.4l1.8-1.6.8-3.2L12 15Z',
      fill: '#FFFFFF',
    }),
  ])
}

// Arc: layered electric-blue curved arch.
function ArcMark({ size }) {
  return wrap(size, [
    h('path', {
      key: 'a1',
      d: 'M5.2 19.6 10.6 4.4c.5-1.3 2.3-1.3 2.8 0l5.4 15.2a1.3 1.3 0 0 1-1.9 1.5c-1.5-.8-3.2-1.3-4.9-1.3s-3.4.5-4.9 1.3a1.3 1.3 0 0 1-1.9-1.5Z',
      fill: '#3B5BFF',
    }),
    h('path', {
      key: 'a2',
      d: 'M7.7 18.8 11.4 8.2c.2-.6 1-.6 1.2 0l3.7 10.6c-1.3-.5-2.8-.8-4.3-.8s-3 .3-4.3.8Z',
      fill: '#89A4FF',
    }),
    h('path', {
      key: 'a3',
      d: 'M9.8 18.1 12 12l2.2 6.1c-.7-.1-1.5-.2-2.2-.2s-1.5.1-2.2.2Z',
      fill: '#FFFFFF',
    }),
  ])
}

// Opera / Opera GX: sculpted crimson ring.
function OperaMark({ size, gx }) {
  const id = useGradPrefix('opr')
  return wrap(size, [
    h('defs', { key: 'd' },
      h('linearGradient', { id, x1: '12', y1: '2', x2: '12', y2: '22', gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: '0%', stopColor: gx ? '#FF2A5F' : '#FF1B2D' }),
        h('stop', { offset: '100%', stopColor: gx ? '#C80D3E' : '#A70014' }))),
    h('path', {
      key: 'o',
      fillRule: 'evenodd',
      clipRule: 'evenodd',
      d: 'M12 2.2a9.8 9.8 0 1 0 0 19.6 9.8 9.8 0 0 0 0-19.6Zm0 3.2c-2.5 0-4.3 2.9-4.3 6.6s1.8 6.6 4.3 6.6 4.3-2.9 4.3-6.6-1.8-6.6-4.3-6.6Z',
      fill: `url(#${id})`,
    }),
  ])
}

// Vivaldi: red rounded badge with white calligraphic V.
function VivaldiMark({ size }) {
  return wrap(size, [
    h('rect', { key: 'r', x: 2.2, y: 2.2, width: 19.6, height: 19.6, rx: 5.2, fill: '#EF3939' }),
    h('path', {
      key: 'v',
      d: 'M6.8 7.8a1.45 1.45 0 0 1 2.7-.6l2.4 4.8c.5 1 1.9 1 2.4 0l1.1-2.2a1.45 1.45 0 1 1 2.6 1.3l-4.6 8.6a1.55 1.55 0 0 1-2.7 0L6.8 9.1a1.5 1.5 0 0 1 0-1.3Z',
      fill: '#FFFFFF',
    }),
  ])
}

// Zen Browser: minimalist concentric rings adapting to theme ink.
function ZenMark({ size }) {
  return wrap(size, [
    h('circle', { key: 'c1', cx: 12, cy: 12, r: 9.2, stroke: 'var(--bt-ink)', strokeWidth: 2 }),
    h('circle', { key: 'c2', cx: 12, cy: 12, r: 5.6, stroke: 'var(--bt-ink)', strokeWidth: 1.7 }),
    h('circle', { key: 'c3', cx: 12, cy: 12, r: 2.4, stroke: 'var(--bt-ink)', strokeWidth: 1.5 }),
  ])
}

function FallbackBrowserMark({ size }) {
  return wrap(size, [
    h('circle', { key: 'c', cx: 12, cy: 12, r: 9.2, stroke: 'var(--bt-ink-2)', strokeWidth: 1.6 }),
    h('path', { key: 'p', d: 'M3 12h18M12 2.8c2.6 2.5 3.9 5.6 3.9 9.2s-1.3 6.7-3.9 9.2c-2.6-2.5-3.9-5.6-3.9-9.2S9.4 5.3 12 2.8Z', stroke: 'var(--bt-ink-2)', strokeWidth: 1.4 }),
  ])
}

export function browserKindOf(source) {
  const kind = String(source?.kind || '').toLowerCase()
  if (kind) return kind
  const idPrefix = String(source?.id || '').split(':')[0].toLowerCase()
  if (idPrefix) return idPrefix
  const name = String(source?.name || source?.label || '').toLowerCase()
  if (name.includes('canary')) return 'chrome-canary'
  if (name.includes('chromium')) return 'chromium'
  if (name.includes('chrome')) return 'chrome'
  if (name.includes('edge')) return 'edge'
  if (name.includes('safari')) return 'safari'
  if (name.includes('firefox')) return 'firefox'
  if (name.includes('brave')) return 'brave'
  if (name.includes('arc')) return 'arc'
  if (name.includes('opera gx')) return 'opera-gx'
  if (name.includes('opera')) return 'opera'
  if (name.includes('vivaldi')) return 'vivaldi'
  if (name.includes('zen')) return 'zen'
  return ''
}

export function BrowserMark({ source, size = 24 }) {
  const kind = browserKindOf(source)
  if (kind === 'chrome-canary') return h(ChromeMark, { size, colors: CHROME_PALETTES.canary })
  if (kind === 'chromium') return h(ChromeMark, { size, colors: CHROME_PALETTES.chromium })
  if (kind.startsWith('chrome')) return h(ChromeMark, { size, colors: CHROME_PALETTES.chrome })
  if (kind.startsWith('edge')) return h(EdgeMark, { size })
  if (kind === 'safari') return h(SafariMark, { size })
  if (kind === 'firefox') return h(FirefoxMark, { size })
  if (kind === 'brave') return h(BraveMark, { size })
  if (kind === 'arc') return h(ArcMark, { size })
  if (kind === 'opera-gx') return h(OperaMark, { size, gx: true })
  if (kind === 'opera') return h(OperaMark, { size, gx: false })
  if (kind === 'vivaldi') return h(VivaldiMark, { size })
  if (kind === 'zen') return h(ZenMark, { size })
  return h(FallbackBrowserMark, { size })
}
