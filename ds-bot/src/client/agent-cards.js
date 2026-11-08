// What a Bot runs on, as the user chooses it: the local agent cards of the Create Bot
// form and the Runs on card of a Bot's settings. Changing it starts a new part of every
// conversation of the Bot, so it asks first.
import { createElement as h, useEffect, useState } from 'react'
import { agentAvatar, isLocalRoute, routeOf } from './agent-routes.js'
import { AgentBadge } from './agent-badge.js'
import { call } from './api.js'
import { avatarAfter, runModeNotes, startModel } from './bot-draft.js'
import { CheckIcon } from './icons.js'
import { ModelMenu } from './model-menu.js'
import { Segmented } from './motion.js'
import { t } from './i18n.js'

// The CLIs found on this machine and the custom agents, read when the list is about to show.
export function useLocalAgents(wanted) {
  const [view, setView] = useState(null)
  const [scanning, setScanning] = useState(false)
  const load = (endpoint) => {
    setScanning(true)
    return call(endpoint).then(setView).catch(() => setView({ detected: [], custom: [] })).finally(() => setScanning(false))
  }
  useEffect(() => { if (wanted && view === null) void load('local-agents') }, [wanted])
  const agents = view === null ? [] : [...view.detected, ...view.custom.map(agent => ({ route: agent.route, name: agent.name, signedIn: null }))]
  return { agents, known: view !== null, scanning, refresh: () => load('local-agent-refresh') }
}

const SIGNED_IN = { true: 'Signed in', false: 'Not signed in', null: 'Sign-in unknown' }

function CliCard({ agent, selected, onPick }) {
  const [copied, setCopied] = useState(false)
  const logo = agentAvatar(agent.route)?.image
  const copySignIn = () => {
    void navigator.clipboard?.writeText(agent.signIn)?.catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return h('div', { className: 'bt-cli', 'data-selected': selected ? '' : undefined },
    h('button', { type: 'button', className: 'bt-cli-pick', 'aria-pressed': selected, onClick: onPick },
      logo ? h('img', { className: 'bt-cli-logo', src: logo, alt: '' }) : h(AgentBadge, { engine: agent.route, size: 28 }),
      h('span', { className: 'bt-cli-copy' },
        h('span', { className: 'bt-cli-name' }, agent.name),
        h('span', { className: 'bt-cli-meta', 'data-state': String(agent.signedIn) },
          h('i', { className: 'bt-cli-dot', 'aria-hidden': true }), t(SIGNED_IN[agent.signedIn]))),
      selected ? h('span', { className: 'bt-cli-check', 'aria-hidden': true }, h(CheckIcon)) : null),
    agent.signedIn === false && agent.signIn
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-cli-login', title: t('Copies the sign-in command'), onClick: copySignIn }, copied ? t('Copied') : t('Sign in'))
      : null)
}

// The cards, or what to do when this machine has none.
export function CliList({ agents, known, scanning, refresh, selected, onPick, actions }) {
  if (!known) return h('div', { className: 'bt-cli-none' }, h('div', { className: 'bt-empty' }, t('Looking for agent CLIs…')))
  if (agents.length === 0) {
    return h('div', { className: 'bt-cli-none' },
      h('div', { className: 'bt-empty' }, scanning ? t('Looking for agent CLIs…') : t('No agent CLIs found')),
      h('div', { className: 'bt-cli-none-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: scanning, onClick: refresh }, t('Refresh')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings?.('local-agents') }, t('Local agents'))))
  }
  return h('div', { className: 'bt-cli-list' }, agents.map(agent => h(CliCard, {
    key: agent.route, agent, selected: selected === agent.route, onPick: () => onPick(agent),
  })))
}

export const RunModeSwitch = ({ mode, setMode }) => h(Segmented, { label: t('Runs on'), value: mode },
  h('button', { type: 'button', 'aria-pressed': mode === 'model', onClick: () => setMode('model') }, t('DS Bot model')),
  h('button', { type: 'button', 'aria-pressed': mode === 'local', onClick: () => setMode('local') }, t('Local agent')))

export const ReadingModels = () => h('span', { className: 'bt-loading' },
  h('i', { className: 'bt-loading-spin', 'aria-hidden': true }), t('Reading models…'))

// A Bot's settings: what it runs on now, and the one way to change it.
export function RunModeCard({ bot, roster, actions, run, Card }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('model')
  const [target, setTarget] = useState('')
  const { agents, known, scanning, refresh } = useLocalAgents(open && mode === 'local')
  const others = agents.filter(agent => agent.route !== bot.engine)
  const engineName = (roster.models ?? []).find(model => model.provider === bot.engine)?.providerName ?? bot.engine
  const start = () => {
    const toLocal = bot.engine === undefined
    setMode(toLocal ? 'local' : 'model')
    setTarget(toLocal ? '' : startModel(roster))
    setOpen(true)
  }
  const switchMode = (next) => {
    setMode(next)
    setTarget(next === 'model' ? startModel(roster) : '')
  }
  const agent = agents.find(entry => entry.route === routeOf(target))
  const changing = target !== '' && (isLocalRoute(target) ? routeOf(target) !== bot.engine : bot.engine !== undefined)
  const confirm = () => run(actions.updateBot(bot.id, { model: target, changeEngine: true, ...avatarAfter(bot, target) })).then((done) => { if (done !== false) setOpen(false) })
  return h(Card, { title: t('Runs on') },
    h('div', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, bot.engine === undefined ? t('DS Bot model') : engineName, bot.engine === undefined ? null : h(AgentBadge, { engine: bot.engine })),
        h('span', { className: 'bt-set-hint' }, bot.engine === undefined ? t('Answers with a model served by DS Bot, with DS Bot\'s tools.') : t('Answers through this CLI on your computer, with its own tools and sign-in.'))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': open, onClick: () => (open ? setOpen(false) : start()) }, open ? t('Cancel') : t('Change'))),
    open ? h('div', { className: 'bt-runmode' },
      h(RunModeSwitch, { mode, setMode: switchMode }),
      mode === 'local'
        ? h(CliList, { agents: others, known, scanning, refresh, selected: routeOf(target), onPick: entry => setTarget(`${entry.route}/default`), actions })
        : h(ModelMenu, { bot: { id: bot.id, name: bot.name, model: target || undefined }, roster, actions, wide: true, withEfforts: false, onPick: setTarget }),
      changing ? h('div', { className: 'bt-runmode-confirm', role: 'group', 'aria-label': t('Change what {name} runs on?', { name: bot.name }) },
        h('div', { className: 'bt-runmode-title' }, t('Change what {name} runs on?', { name: bot.name })),
        h('ul', { className: 'bt-runmode-notes' }, runModeNotes({ bot, roster, target, agent }).map(note => h('li', { key: note }, note))),
        h('button', { type: 'button', className: 'bt-send', onClick: () => void confirm() }, t('Change and start a new part'))) : null) : null)
}

export const AGENT_CARDS_CSS = `
.bt-cli-list{display:flex;flex-direction:column;gap:8px}
.bt-cli{display:flex;align-items:center;gap:4px;padding:5px 6px 5px 8px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);transition:background-color .12s ease,box-shadow .12s ease}
.bt-cli:hover{background:var(--bt-hover)}
.bt-cli[data-selected]{box-shadow:inset 0 0 0 1.5px var(--bt-accent)}
.bt-cli-pick{display:flex;align-items:center;gap:10px;flex:1;min-width:0;min-height:42px;padding:2px 4px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-cli-pick:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-cli-logo{flex:none;width:28px;height:28px;border-radius:8px}
.bt-cli-copy{display:flex;flex:1;flex-direction:column;min-width:0}
.bt-cli-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-cli-meta{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-cli-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3)}
.bt-cli-meta[data-state=true] .bt-cli-dot{background:var(--bt-green)}
.bt-cli-check{flex:none;display:inline-flex;width:16px;height:16px;color:var(--bt-accent)}
.bt-cli-login{flex:none;margin-right:2px}
.bt-cli-none{display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px 12px;border:1px dashed var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
.bt-cli-none .bt-empty{padding:0}
.bt-cli-none-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.bt-field-label .bt-loading{display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-weight:400;color:var(--bt-ink-3)}
.bt-loading-spin{flex:none;width:10px;height:10px;border-radius:50%;border:1.5px solid var(--bt-line-2);border-top-color:var(--bt-ink-3);animation:bt-model-spin .7s linear infinite}
.bt-runmode{display:flex;flex-direction:column;gap:12px;padding:0 12px 12px}
.bt-runmode-confirm{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border-radius:12px;background:var(--bt-hover)}
.bt-runmode-title{font-size:13px;line-height:18px;font-weight:600}
.bt-runmode-notes{display:flex;flex-direction:column;gap:4px;margin:0;padding:0 0 0 16px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
@media (prefers-reduced-motion:reduce){.bt-loading-spin{animation-duration:2s}}
`
