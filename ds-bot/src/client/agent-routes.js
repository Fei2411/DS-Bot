// Local-agent routes and their badge marks, kept free of React so plain modules
// (the create-Bot payload, tests) can use them. An agent shows its own logo
// (agent-logos.js); the monogram is for agents without one.
import { INKS } from './inks.js'
import { AGENT_LOGOS } from './agent-logos.js'

// route -> [glyph, ink name]. Custom agents (acp-*) share the 'AC' mark.
export const AGENT_BADGES = {
  'devin-cli': ['DV', 'violet'],
  'claude-code': ['CC', 'tangerine'],
  'codex-cli': ['CX', 'green'],
  'opencode': ['OC', 'blue'],
  'cursor-cli': ['CU', 'magenta'],
  'gemini-cli': ['GM', 'yellow'],
  'grok-cli': ['GX', 'graphite'],
  'cline': ['CL', 'cyan'],
  'qwen-code': ['QW', 'cobalt'],
  'goose': ['GS', 'brown'],
}
const CUSTOM = ['AC', 'rose']

export const logoOf = engine => AGENT_LOGOS[engine]

export const badgeOf = engine => AGENT_BADGES[engine] ?? (engine?.startsWith('acp-') ? CUSTOM : undefined)

// A model ref's provider part is a local-agent route when the CLIs serve it.
export const isLocalRoute = ref => badgeOf(String(ref ?? '').split('/')[0]) !== undefined

export const routeOf = ref => String(ref ?? '').split('/')[0]

// The models a pick can go to from `ref`: a local agent lists only its own, and
// everything else lists DS Bot's models. What a Bot runs on changes in its settings.
export function modelsFor(models, ref) {
  const list = models ?? []
  return isLocalRoute(ref)
    ? list.filter(model => routeOf(model.ref) === routeOf(ref))
    : list.filter(model => !isLocalRoute(model.ref))
}

// A badge-style avatar image for a new abot: the monogram large on its ink.
export function agentAvatar(engine) {
  const logo = logoOf(engine)
  if (logo?.kind === 'image') return { image: logo.src }
  const badge = badgeOf(engine)
  if (badge === undefined) return undefined
  const [glyph, ink] = badge
  const mark = logo?.kind === 'path'
    ? `<rect width="64" height="64" rx="16" fill="${INKS.black[1]}"/><g transform="translate(14 14) scale(1.5)"><path d="${logo.d}" fill="#${logo.hex}"/></g>`
    : `<rect width="64" height="64" rx="16" fill="${INKS[ink][0]}"/><text x="32" y="41" text-anchor="middle" font-size="26" font-weight="700" fill="${INKS.black[1]}" font-family="system-ui,sans-serif">${glyph}</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark}</svg>`
  return { image: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` }
}
