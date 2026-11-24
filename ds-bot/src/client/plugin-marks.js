// Official brand marks and clean domain metadata for DS Bot's Plugins panel.
// - Playwright mark: official SVG paths from playwright.dev/img/playwright-logo.svg (Apache-2.0)
// - Ego mark: official geometric three-ellipse mark (evenodd) from citrolabs/ego-lite
// - Chrome mark: clean 4-color Chrome wheel for Chrome DevTools MCP
// Marks render in calm grayscale when inactive and bloom into full color on
// activation, matching Connectors (connectors-page.js).
import { createElement as h } from 'react'

const svg = (...kids) => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, ...kids)

// Official Playwright logo (https://playwright.dev/img/playwright-logo.svg, viewBox 400x400).
const PlaywrightOfficialMark = () => h('svg', { width: 22, height: 22, viewBox: '20 68 352 270', fill: 'none', 'aria-hidden': true },
  h('path', { d: 'M136.444 221.556C123.558 225.213 115.104 231.625 109.535 238.032C114.869 233.364 122.014 229.08 131.652 226.348C141.51 223.554 149.92 223.574 156.869 224.915V219.481C150.941 218.939 144.145 219.371 136.444 221.556ZM108.946 175.876L61.0895 188.484C61.0895 188.484 61.9617 189.716 63.5767 191.36L104.153 180.668C104.153 180.668 103.578 188.077 98.5847 194.705C108.03 187.559 108.946 175.876 108.946 175.876ZM149.005 288.347C81.6582 306.486 46.0272 228.438 35.2396 187.928C30.2556 169.229 28.0799 155.067 27.5 145.928C27.4377 144.979 27.4665 144.179 27.5336 143.446C24.04 143.657 22.3674 145.473 22.7077 150.721C23.2876 159.855 25.4633 174.016 30.4473 192.721C41.2301 233.225 76.8659 311.273 144.213 293.134C158.872 289.185 169.885 281.992 178.152 272.81C170.532 279.692 160.995 285.112 149.005 288.347ZM161.661 128.11V132.903H188.077C187.535 131.206 186.989 129.677 186.447 128.11H161.661Z', fill: '#2D4552' }),
  h('path', { d: 'M193.981 167.584C205.861 170.958 212.144 179.287 215.465 186.658L228.711 190.42C228.711 190.42 226.904 164.623 203.57 157.995C181.741 151.793 168.308 170.124 166.674 172.496C173.024 167.972 182.297 164.268 193.981 167.584ZM299.422 186.777C277.573 180.547 264.145 198.916 262.535 201.255C268.89 196.736 278.158 193.031 289.837 196.362C301.698 199.741 307.976 208.06 311.307 215.436L324.572 219.212C324.572 219.212 322.736 193.41 299.422 186.777ZM286.262 254.795L176.072 223.99C176.072 223.99 177.265 230.038 181.842 237.869L274.617 263.805C282.255 259.386 286.262 254.795 286.262 254.795ZM209.867 321.102C122.618 297.71 133.166 186.543 147.284 133.865C153.097 112.156 159.073 96.0203 164.029 85.204C161.072 84.5953 158.623 86.1529 156.203 91.0746C150.941 101.747 144.212 119.124 137.7 143.45C123.586 196.127 113.038 307.29 200.283 330.682C241.406 341.699 273.442 324.955 297.323 298.659C274.655 319.19 245.714 330.701 209.867 321.102Z', fill: '#2D4552' }),
  h('path', { d: 'M161.661 262.296V239.863L99.3324 257.537C99.3324 257.537 103.938 230.777 136.444 221.556C146.302 218.762 154.713 218.781 161.661 220.123V128.11H192.869C189.471 117.61 186.184 109.526 183.423 103.909C178.856 94.612 174.174 100.775 163.545 109.665C156.059 115.919 137.139 129.261 108.668 136.933C80.1966 144.61 57.179 142.574 47.5752 140.911C33.9601 138.562 26.8387 135.572 27.5049 145.928C28.0847 155.062 30.2605 169.224 35.2445 187.928C46.0272 228.433 81.663 306.481 149.01 288.342C166.602 283.602 179.019 274.233 187.626 262.291H161.661V262.296ZM61.0848 188.484L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6614 203.743 61.0848 188.484 61.0848 188.484Z', fill: '#E2574C' }),
  h('path', { d: 'M341.786 129.174C329.345 131.355 299.498 134.072 262.612 124.185C225.716 114.304 201.236 97.0224 191.537 88.8994C177.788 77.3834 171.74 69.3802 165.788 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.098C297.093 344.47 343.53 242.92 357.644 190.238C364.157 165.917 367.013 147.5 367.799 135.625C368.695 122.173 359.455 126.078 341.786 129.174ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756ZM223.42 268.713C182.403 256.698 176.077 223.99 176.077 223.99L286.262 254.796C286.262 254.791 264.021 280.578 223.42 268.713ZM262.377 201.495C262.377 201.495 276.107 180.126 299.422 186.773C322.736 193.411 324.572 219.208 324.572 219.208L262.377 201.495Z', fill: '#2EAD33' }),
  h('path', { d: 'M139.88 246.04L99.3324 257.532C99.3324 257.532 103.737 232.44 133.607 222.496L110.647 136.33L108.663 136.933C80.1918 144.611 57.1742 142.574 47.5704 140.911C33.9554 138.563 26.834 135.572 27.5001 145.929C28.08 155.063 30.2557 169.224 35.2397 187.929C46.0225 228.433 81.6583 306.481 149.005 288.342L150.989 287.719L139.88 246.04ZM61.0848 188.485L108.946 175.876C108.946 175.876 107.551 194.288 89.6087 199.018C71.6615 203.743 61.0848 188.485 61.0848 188.485Z', fill: '#D65348' }),
  h('path', { d: 'M225.27 269.163L223.415 268.712C182.398 256.698 176.072 223.99 176.072 223.99L232.89 239.872L262.971 124.281L262.607 124.185C225.711 114.304 201.232 97.0224 191.532 88.8994C177.783 77.3834 171.735 69.3802 165.783 81.4857C160.526 92.163 153.797 109.54 147.284 133.866C133.171 186.543 122.623 297.706 209.867 321.097L211.655 321.5L225.27 269.163ZM166.497 172.756C166.497 172.756 180.246 151.372 203.565 158C226.899 164.628 228.706 190.425 228.706 190.425L166.497 172.756Z', fill: '#1D8D22' }),
  h('path', { d: 'M141.946 245.451L131.072 248.537C133.641 263.019 138.169 276.917 145.276 289.195C146.513 288.922 147.74 288.687 149 288.342C152.302 287.451 155.364 286.348 158.312 285.145C150.371 273.361 145.118 259.789 141.946 245.451ZM137.7 143.451C132.112 164.307 127.113 194.326 128.489 224.436C130.952 223.367 133.554 222.371 136.444 221.551L138.457 221.101C136.003 188.939 141.308 156.165 147.284 133.866C148.799 128.225 150.318 122.978 151.832 118.085C149.393 119.637 146.767 121.228 143.776 122.867C141.759 129.093 139.722 135.898 137.7 143.451Z', fill: '#C04B41' }),
)

// Official Ego logo (citrolabs/ego-lite): overlapping circle + oval (evenodd lens cutout) + slim oval.
const EgoOfficialMark = () => svg(
  h('path', {
    fillRule: 'evenodd',
    clipRule: 'evenodd',
    fill: 'var(--bt-mark-ink)',
    d: [
      // Left circle: cx=7.86, cy=12, rx=6.15, ry=6.12
      'M1.71 12a6.15 6.12 0 1 0 12.3 0a6.15 6.12 0 1 0 -12.3 0Z',
      // Middle oval: cx=14.18, cy=12, rx=3.12, ry=6.12 (intersects circle → crisp lens cutout)
      'M11.06 12a3.12 6.12 0 1 0 6.24 0a3.12 6.12 0 1 0 -6.24 0Z',
      // Right slim oval: cx=20.70, cy=12, rx=1.57, ry=6.12
      'M19.13 12a1.57 6.12 0 1 0 3.14 0a1.57 6.12 0 1 0 -3.14 0Z',
    ].join(' '),
  }),
)

// Official-geometry 4-color Chrome wheel for Chrome DevTools MCP (zero SVG IDs).
const ChromeDevtoolsMark = () => svg(
  h('path', { d: 'M3.51 7.1A9.8 9.8 0 0 1 20.49 7.1H12a4.9 4.9 0 0 0-4.24 7.35Z', fill: '#EA4335' }),
  h('path', { d: 'M20.49 7.1A9.8 9.8 0 0 1 12 21.8l4.24-7.35A4.9 4.9 0 0 0 12 7.1Z', fill: '#FBBC04' }),
  h('path', { d: 'M12 21.8A9.8 9.8 0 0 1 3.51 7.1l4.25 7.35a4.9 4.9 0 0 0 8.48 0Z', fill: '#34A853' }),
  h('circle', { cx: 12, cy: 12, r: 5.05, fill: '#FFFFFF' }),
  h('circle', { cx: 12, cy: 12, r: 3.85, fill: '#4285F4' }),
)

// Read-only Browser: clean browser frame with a quiet cobalt viewing eye.
const ReadonlyBrowserMark = () => svg(
  h('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 3.2, stroke: '#3B82F6', strokeWidth: 1.6 }),
  h('path', { d: 'M2.5 8.5h19', stroke: '#3B82F6', strokeWidth: 1.4 }),
  h('path', { d: 'M6.8 14.3c1.25-1.9 3.15-2.85 5.2-2.85s3.95.95 5.2 2.85c-1.25 1.9-3.15 2.85-5.2 2.85s-3.95-.95-5.2-2.85Z', stroke: '#2563EB', strokeWidth: 1.5, strokeLinejoin: 'round' }),
  h('circle', { cx: 12, cy: 14.3, r: 1.5, fill: '#2563EB' }),
)

// Clean restrained fallback marks for non-browser / custom plugins.
const CustomBrowserMark = () => svg(
  h('circle', { cx: 12, cy: 12, r: 8.5, stroke: '#3B82F6', strokeWidth: 1.6 }),
  h('path', { d: 'M3.8 12h16.4M12 3.5c2.4 2.3 3.7 5.2 3.7 8.5s-1.3 6.2-3.7 8.5c-2.4-2.3-3.7-5.2-3.7-8.5s1.3-6.2 3.7-8.5Z', stroke: '#3B82F6', strokeWidth: 1.4 }),
)

const ProtocolMark = () => svg(
  h('path', { d: 'M5.5 9h13M14.8 5.8 18.5 9l-3.7 3.2', stroke: '#4F46E5', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  h('path', { d: 'M18.5 15h-13M9.2 11.8 5.5 15l3.7 3.2', stroke: '#0EA5E9', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
)

const TeamMark = () => svg(
  h('path', { d: 'M12 6.8 6.8 16h10.4L12 6.8Z', stroke: '#10B981', strokeWidth: 1.5, strokeLinejoin: 'round' }),
  h('circle', { cx: 12, cy: 6.5, r: 2.2, fill: '#6366F1' }),
  h('circle', { cx: 6.8, cy: 16.2, r: 2.1, fill: '#10B981' }),
  h('circle', { cx: 17.2, cy: 16.2, r: 2.1, fill: '#3B82F6' }),
)

const DevCodeMark = () => svg(
  h('path', { d: 'M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4', stroke: '#4F46E5', strokeWidth: 1.85, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  h('path', { d: 'M13.4 6.5 10.6 17.5', stroke: '#0EA5E9', strokeWidth: 1.7, strokeLinecap: 'round' }),
)

const TerminalMark = () => svg(
  h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 3.2, stroke: '#0D9488', strokeWidth: 1.6 }),
  h('path', { d: 'M7.2 9.8 10.2 12.2 7.2 14.6', stroke: '#0D9488', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  h('path', { d: 'M12 14.8h4.5', stroke: '#64748B', strokeWidth: 1.7, strokeLinecap: 'round' }),
)

const GenericMcpMark = () => svg(
  h('path', { d: 'M7.5 15.2 12 10.7l4.5 4.5M12 10.7V6.5', stroke: '#7C3AED', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  h('circle', { cx: 12, cy: 6, r: 1.9, fill: '#0EA5E9' }),
  h('circle', { cx: 7.5, cy: 15.8, r: 2, fill: '#7C3AED' }),
  h('circle', { cx: 16.5, cy: 15.8, r: 2, fill: '#7C3AED' }),
)

const ModularPluginMark = () => svg(
  h('path', { d: 'M12 4.6 18.4 8.3v7.4L12 19.4l-6.4-3.7V8.3L12 4.6Z', stroke: '#6366F1', strokeWidth: 1.6, strokeLinejoin: 'round' }),
  h('path', { d: 'M12 12v7.4M5.6 8.3 12 12l6.4-3.7', stroke: '#6366F1', strokeWidth: 1.4, strokeLinejoin: 'round' }),
)

export const ExtensionsClusterMark = ModularPluginMark

const PLUGIN_MARKS = {
  'builtin:readonly': ReadonlyBrowserMark,
  'builtin:refs': PlaywrightOfficialMark,
  'builtin:script': PlaywrightOfficialMark,
  'builtin:task': PlaywrightOfficialMark,
  'dsh:dsh-ego-browser': EgoOfficialMark,
  'mcp:playwright-mcp': PlaywrightOfficialMark,
  'mcp:chrome-devtools-mcp': ChromeDevtoolsMark,
}

const DOMAIN_HINT_RULES = [
  [/(?:^|[-_:/\s])(acp|protocol|rpc|bridge)(?:$|[-_:/\s])/i, ProtocolMark],
  [/(?:^|[-_:/\s])(team|swarm|multi[-_]?agent|agents?)(?:$|[-_:/\s])/i, TeamMark],
  [/(?:^|[-_:/\s])(dev|debug|diag|devtools|developer|inspect)(?:$|[-_:/\s])/i, DevCodeMark],
  [/(?:^|[-_:/\s])(headless|cli|shell|daemon|runtime|terminal)(?:$|[-_:/\s])/i, TerminalMark],
]

function hashHue(id) {
  let hash = 0
  for (const ch of String(id ?? 'plugin')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 360
}

export function PluginMark({ plugin }) {
  if (!plugin) return null
  const Known = PLUGIN_MARKS[plugin.id]
  if (Known) return h(Known)
  if (plugin.custom) {
    const letter = String(plugin.name || plugin.id || '?').trim().slice(0, 1).toUpperCase()
    return h('span', { className: 'bt-plg-mono', style: { '--bt-hue': hashHue(plugin.id) }, 'aria-hidden': true }, letter)
  }
  if (plugin.slot === 'browser' || plugin.category === 'browser') return h(CustomBrowserMark)
  const text = [plugin.id, plugin.packageName, plugin.name, ...(plugin.tags ?? [])].filter(Boolean).join(' ')
  for (const [re, Mark] of DOMAIN_HINT_RULES) {
    if (re.test(text)) return h(Mark)
  }
  if (plugin.kind === 'mcp') return h(GenericMcpMark)
  return h(ModularPluginMark)
}

const BROWSER_META = {
  'builtin:readonly': {
    url: 'browser://readonly',
    traits: ['Read current page', 'Zero writes'],
  },
  'builtin:refs': {
    url: 'browser://playwright/refs',
    traits: ['Click & forms', 'Element refs', 'Screenshots'],
  },
  'builtin:script': {
    url: 'browser://playwright/script',
    traits: ['JS scripts', 'Batch steps', 'Fast'],
  },
  'builtin:task': {
    url: 'browser://playwright/task',
    traits: ['Multi-step', 'Autonomous'],
  },
  'dsh:dsh-ego-browser': {
    url: 'browser://ego-lite',
    traits: ['Shared login', 'Real Chromium', 'Human + AI'],
  },
  'mcp:playwright-mcp': {
    url: 'browser://playwright-mcp',
    traits: ['Accessibility tree', 'Standard MCP'],
  },
  'mcp:chrome-devtools-mcp': {
    url: 'browser://chrome-devtools',
    traits: ['DOM & console', 'Network debug', 'CDP'],
  },
}

export function browserMetaFor(plugin) {
  if (!plugin) return { url: 'browser://none', traits: [] }
  if (BROWSER_META[plugin.id]) return BROWSER_META[plugin.id]
  const slug = String(plugin.id || 'custom').replace(/^(builtin|dsh|mcp|provider):/, '').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()
  return {
    url: `browser://${slug || 'custom'}`,
    traits: plugin.kind === 'mcp' ? ['Standard MCP', 'Browser slot'] : ['Browser slot'],
  }
}
