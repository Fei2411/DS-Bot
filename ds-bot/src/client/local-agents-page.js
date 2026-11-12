// The Local agents page: the agent CLIs found on this machine and the custom
// ACP agents the user added. A Bot runs on one of these when the user chooses it:
// on the Create Bot form, or later under Runs on in the Bot's settings.
import { createElement as h, useEffect, useState } from 'react'
import { AgentLogo, shortVersion } from './agent-cards.js'
import { PlusIcon, TrashIcon } from './icons.js'
import { call } from './api.js'
import { t } from './i18n.js'


function AgentForm({ initial, submit, close }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState((initial?.args ?? []).join(' '))
  const [error, setError] = useState('')
  const save = () => {
    const payload = { name, command, args: args.split(/\s+/).filter(Boolean) }
    submit(payload).then(() => close()).catch(failure => setError(failure?.message ?? String(failure)))
  }
  return h('div', { className: 'bt-set-form' },
    h('label', { className: 'bt-set-field' }, h('span', null, t('Name')), h('input', { className: 'bt-input', value: name, autoFocus: true, onChange: event => setName(event.target.value) })),
    h('div', { className: 'bt-set-form-row' },
      h('label', { className: 'bt-set-field' }, h('span', null, t('Command')), h('input', { className: 'bt-input bt-la-code-input', value: command, placeholder: 'my-agent', spellCheck: false, onChange: event => setCommand(event.target.value) })),
      h('label', { className: 'bt-set-field' }, h('span', null, t('Arguments')), h('input', { className: 'bt-input bt-la-code-input', value: args, placeholder: 'acp', spellCheck: false, onChange: event => setArgs(event.target.value) }))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-actions bt-set-form-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: save }, t('Save'))))
}

// A detected agent's row: logo, name + version, path, and sign-in state. An agent
// that is already signed in or has no sign-in command of its own shows no Sign in
// button; when clicked, the copy result is always visible (#1083).
export function AgentSignInRow({ agent }) {
  const [note, setNote] = useState(null)
  const copy = () => {
    const done = copied => setNote({ copied, command: agent.signIn })
    try {
      const writing = navigator.clipboard?.writeText(agent.signIn)
      if (writing === undefined) { done(false); return }
      void Promise.resolve(writing).then(() => done(true), () => done(false))
    } catch {
      done(false)
    }
  }
  const version = shortVersion(agent.version)
  const canSignIn = Boolean(agent.signIn) && agent.signedIn !== true
  const status = agent.signedIn === true ? t('Signed in') : agent.signedIn === false ? t('Not signed in') : null
  const message = note === null ? null : h('span', {
    className: note.copied ? 'bt-note bt-la-note' : 'bt-note bt-la-note bt-danger',
    role: note.copied ? 'status' : 'alert',
  }, note.copied
    ? t('Sign-in command copied. Run it in a terminal: {command}', { command: note.command })
    : t('Could not copy the sign-in command. Run this in a terminal: {command}', { command: note.command }))
  return h('div', { className: 'bt-set-row bt-la-row' },
    h(AgentLogo, { route: agent.route, name: agent.name, size: 32, className: 'bt-cli-logo bt-la-logo' }),
    h('div', { className: 'bt-set-copy bt-la-copy' },
      h('span', { className: 'bt-la-head' },
        h('span', { className: 'bt-la-name' }, agent.name),
        version ? h('span', { className: 'bt-la-ver' }, version) : null),
      agent.path ? h('span', { className: 'bt-la-path' }, agent.path) : null,
      message),
    status !== null || canSignIn ? h('div', { className: 'bt-set-control bt-la-actions' },
      status !== null ? h('span', { className: 'bt-la-state', 'data-state': String(agent.signedIn) },
        h('i', { className: 'bt-cli-dot', 'aria-hidden': true }), status) : null,
      canSignIn ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', title: t('Copies the sign-in command'), onClick: copy }, t('Sign in')) : null) : null)
}

export function LocalAgentsPage({ run, Row }) {
  const [view, setView] = useState(null)
  const [editing, setEditing] = useState(null) // 'new' | agent object
  // run() reports a failure and resolves to whether it worked, so the page's
  // data is taken from the call itself.
  const load = endpoint => run(call(endpoint).then(setView))
  const refresh = () => load('local-agent-refresh')
  useEffect(() => { void load('local-agents') }, [])
  if (view === null) return null
  if (view.available === false) return h('p', { className: 'bt-set-hint' }, t('This DSH cannot register local agent routes.'))
  return [
    h('section', { key: 'found', className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Detected agents')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: refresh }, t('Refresh'))),
      h('div', { className: 'bt-set-card' },
        view.detected.length === 0 ? h(Row, { label: t('No agent CLIs found') }) : null,
        view.detected.map(agent => h(AgentSignInRow, { key: agent.route, agent, Row })))),
    h('section', { key: 'custom', className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Custom agents')),
        editing === 'new' ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'aria-label': t('Add agent'), onClick: () => setEditing('new') }, h(PlusIcon), t('Add agent'))),
      h('div', { className: 'bt-set-card' },
        view.custom.length === 0 && editing !== 'new'
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('ACP-compatible agents, added by command.')))
          : null,
        view.custom.map(agent => (editing === agent
          ? h(AgentForm, { key: agent.id, initial: agent, close: () => setEditing(null), submit: payload => call('local-agent-update', { id: agent.id, ...payload }).then(() => load('local-agents')) })
          : h('div', { key: agent.id, className: 'bt-set-row bt-la-row' },
            h(AgentLogo, { route: agent.route, name: agent.name, size: 32, className: 'bt-cli-logo bt-la-logo' }),
            h('div', { className: 'bt-set-copy bt-la-copy' },
              h('span', { className: 'bt-la-head' }, h('span', { className: 'bt-la-name' }, agent.name)),
              h('span', { className: 'bt-la-path' }, [agent.command, ...(agent.args ?? [])].join(' '))),
            h('div', { className: 'bt-set-control bt-la-actions' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setEditing(agent) }, t('Edit')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', 'aria-label': t('Remove'), onClick: () => run(call('local-agent-remove', { id: agent.id })).then(() => load('local-agents')) }, h(TrashIcon)))))),
        editing === 'new'
          ? h(AgentForm, { key: 'new', close: () => setEditing(null), submit: payload => call('local-agent-add', payload).then(() => load('local-agents')) })
          : null)),
  ]
}
