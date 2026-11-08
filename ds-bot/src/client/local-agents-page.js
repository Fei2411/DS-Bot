// The Local agents page: the agent CLIs found on this machine and the custom
// ACP agents the user added. A Bot runs on one of these when the user chooses it:
// on the Create Bot form, or later under Runs on in the Bot's settings.
import { createElement as h, useEffect, useState } from 'react'
import { CheckIcon, ChevronRightIcon, PlusIcon, TrashIcon } from './icons.js'
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
    h('label', { className: 'bt-set-field' }, h('span', null, t('Name')), h('input', { className: 'bt-input', value: name, onChange: event => setName(event.target.value) })),
    h('label', { className: 'bt-set-field' }, h('span', null, t('Command')), h('input', { className: 'bt-input', value: command, placeholder: 'my-agent', onChange: event => setCommand(event.target.value) })),
    h('label', { className: 'bt-set-field' }, h('span', null, t('Arguments')), h('input', { className: 'bt-input', value: args, placeholder: 'acp', onChange: event => setArgs(event.target.value) })),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-actions' },
      h('button', { type: 'button', className: 'bt-primary', onClick: save }, t('Save')),
      h('button', { type: 'button', className: 'bt-soft', onClick: close }, t('Cancel'))))
}

export function LocalAgentsPage({ run, Section, Row }) {
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
    h(Section, { key: 'found', title: t('Detected agents') },
      view.detected.length === 0 ? h(Row, { label: t('No agent CLIs found') }) : null,
      view.detected.map(agent => h(Row, {
        key: agent.route, label: agent.name,
        hint: [agent.path, agent.version].filter(Boolean).join(' · '),
      },
        h('div', { className: 'bt-set-actions' },
          agent.signIn ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', title: t('Copies the sign-in command'), onClick: () => navigator.clipboard?.writeText(agent.signIn).catch(() => {}) }, t('Sign in')) : null,
          h('span', { className: 'bt-tag' }, agent.signedIn === true ? t('Signed in') : agent.signedIn === false ? t('Not signed in') : agent.path ? t('Found') : t('Not found'))))),
      h(Row, { key: 'refresh', label: t('Refresh'), hint: t('Scan again for agent CLIs.') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: refresh }, h(CheckIcon)))),
    h(Section, { key: 'custom', title: t('Custom agents') },
      h('p', { className: 'bt-set-hint' }, t('ACP-compatible agents, added by command.')),
      view.custom.map(agent => (editing === agent
        ? h(AgentForm, { key: agent.id, initial: agent, close: () => setEditing(null), submit: payload => call('local-agent-update', { id: agent.id, ...payload }).then(() => load('local-agents')) })
        : h(Row, { key: agent.id, label: agent.name, hint: [agent.command, ...(agent.args ?? [])].join(' ') },
          h('div', { className: 'bt-set-actions' },
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setEditing(agent) }, h(ChevronRightIcon)),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', 'aria-label': t('Remove'), onClick: () => run(call('local-agent-remove', { id: agent.id })).then(() => load('local-agents')) }, h(TrashIcon)))))),
      editing === 'new'
        ? h(AgentForm, { key: 'new', close: () => setEditing(null), submit: payload => call('local-agent-add', payload).then(() => load('local-agents')) })
        : h(Row, { key: 'add', label: t('Add agent') },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Add agent'), onClick: () => setEditing('new') }, h(PlusIcon)))),
  ]
}
