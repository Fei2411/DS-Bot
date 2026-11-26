// The Local agents page: the agent CLIs found on this machine, isolated account
// profiles for built-in CLIs, and custom ACP agents the user added. A Bot runs
// on one of these when the user chooses it: on the Create Bot form, or later
// under Runs on in the Bot's settings.
import { createElement as h, useEffect, useRef, useState } from 'react'
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

function ProfileForm({ initial, detected, submit, close }) {
  const [baseRoute, setBaseRoute] = useState(initial?.baseRoute ?? detected[0]?.route ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [configDir, setConfigDir] = useState(initial?.customConfigDir ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const isEdit = Boolean(initial)
  const selectedBaseRoute = isEdit
    ? initial.baseRoute
    : (detected.some(item => item.route === baseRoute) ? baseRoute : (detected[0]?.route ?? ''))
  const canSave = !saving && (isEdit || selectedBaseRoute !== '')
  const save = () => {
    if (savingRef.current || !canSave) return
    savingRef.current = true
    setSaving(true)
    setError('')
    const payload = isEdit
      ? { route: initial.route, name, configDir: configDir.trim() === '' ? null : configDir.trim() }
      : { baseRoute: selectedBaseRoute, name, ...(configDir.trim() === '' ? {} : { configDir: configDir.trim() }) }
    submit(payload)
      .then(() => close())
      .catch((failure) => {
        savingRef.current = false
        setSaving(false)
        setError(failure?.message ?? String(failure))
      })
  }
  return h('div', { className: 'bt-set-form' },
    h('div', { className: 'bt-set-form-row' },
      isEdit
        ? h('label', { className: 'bt-set-field' },
          h('span', null, t('Agent')),
          h('input', { className: 'bt-input', value: detected.find(item => item.route === initial.baseRoute)?.name ?? initial.baseRoute, disabled: true }))
        : h('label', { className: 'bt-set-field' },
          h('span', null, t('Agent')),
          h('select', { className: 'bt-select', value: selectedBaseRoute, disabled: saving || detected.length === 0, onChange: event => setBaseRoute(event.target.value) },
            detected.map(agent => h('option', { key: agent.route, value: agent.route }, agent.name)))),
      h('label', { className: 'bt-set-field' },
        h('span', null, t('Profile name')),
        h('input', { className: 'bt-input', value: name, autoFocus: true, disabled: saving, placeholder: 'Work', maxLength: 32, onChange: event => setName(event.target.value) }))),
    h('label', { className: 'bt-set-field' },
      h('span', null, t('Config folder')),
      h('input', { className: 'bt-input bt-la-code-input', value: configDir, disabled: saving, placeholder: t('Default folder'), spellCheck: false, onChange: event => setConfigDir(event.target.value) })),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-set-actions bt-set-form-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: saving, onClick: close }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: !canSave, onClick: save }, saving ? t('Saving…') : t('Save'))))
}

function useCopySignIn(command) {
  const [note, setNote] = useState(null)
  const copy = () => {
    const done = copied => setNote({ copied, command })
    try {
      const writing = navigator.clipboard?.writeText(command)
      if (writing === undefined) { done(false); return }
      void Promise.resolve(writing).then(() => done(true), () => done(false))
    } catch {
      done(false)
    }
  }
  const message = note === null ? null : h('span', {
    className: note.copied ? 'bt-note bt-la-note' : 'bt-note bt-la-note bt-danger',
    role: note.copied ? 'status' : 'alert',
  }, note.copied
    ? t('Sign-in command copied. Run it in a terminal: {command}', { command: note.command })
    : t('Could not copy the sign-in command. Run this in a terminal: {command}', { command: note.command }))
  return { copy, message }
}

// A detected agent's row: logo, name + version, path, and sign-in state. An agent
// that is already signed in or has no sign-in command of its own shows no Sign in
// button; when clicked, the copy result is always visible (#1083).
export function AgentSignInRow({ agent }) {
  const { copy, message } = useCopySignIn(agent.signIn)
  const version = shortVersion(agent.version)
  const canSignIn = Boolean(agent.signIn) && agent.signedIn !== true
  const status = agent.signedIn === true ? t('Signed in') : agent.signedIn === false ? t('Not signed in') : null
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

function ProfileRow({ profile, armed, onEdit, onRemove, onBlurRemove }) {
  const { copy, message } = useCopySignIn(profile.signIn)
  const version = shortVersion(profile.version)
  const canSignIn = profile.available !== false && Boolean(profile.signIn) && profile.signedIn !== true
  const status = profile.available === false ? t('Not installed')
    : profile.signedIn === true ? t('Signed in')
      : profile.signedIn === false ? t('Not signed in') : null
  return h('div', { className: 'bt-set-row bt-la-row' },
    h(AgentLogo, { route: profile.route, name: profile.displayName ?? profile.name, size: 32, className: 'bt-cli-logo bt-la-logo' }),
    h('div', { className: 'bt-set-copy bt-la-copy' },
      h('span', { className: 'bt-la-head' },
        h('span', { className: 'bt-la-name' }, profile.displayName ?? profile.name),
        version ? h('span', { className: 'bt-la-ver' }, version) : null),
      profile.configDir ? h('span', { className: 'bt-la-path' }, profile.configDir) : null,
      message),
    h('div', { className: 'bt-set-control bt-la-actions' },
      status !== null ? h('span', { className: 'bt-la-state', 'data-state': String(profile.available === false ? false : profile.signedIn) },
        h('i', { className: 'bt-cli-dot', 'aria-hidden': true }), status) : null,
      canSignIn ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', title: t('Copies the sign-in command'), onClick: copy }, t('Sign in')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onEdit }, t('Edit')),
      h('button', {
        type: 'button',
        className: armed ? 'bt-soft bt-soft-sm bt-danger bt-la-armed' : 'bt-soft bt-soft-sm bt-danger',
        'aria-label': armed ? t('Click again to remove') : t('Remove'),
        onClick: onRemove,
        onBlur: onBlurRemove,
      }, armed ? t('Remove?') : h(TrashIcon))))
}

export function LocalAgentsPage({ run, Row }) {
  const [view, setView] = useState(null)
  const [editing, setEditing] = useState(null) // 'new' | custom.id | 'profile:new' | 'profile:' + route
  const [armedRemove, setArmedRemove] = useState(null)
  const [failed, setFailed] = useState(false)
  // run() reports a failure and resolves to whether it worked, so the page's
  // data is taken from the call itself.
  const load = (endpoint) => {
    setFailed(false)
    return run(call(endpoint).then((next) => { setView(next); setFailed(false) }, (err) => { setFailed(true); throw err }))
  }
  const refresh = () => load('local-agent-refresh')
  useEffect(() => { void load('local-agents') }, [])
  if (view === null) {
    return h('section', { className: 'bt-set-section', 'data-tour': 'la-detected' },
      h('div', { className: 'bt-la-sec-head' }, h('h3', null, t('Detected agents'))),
      h('div', { className: 'bt-set-card' },
        failed
          ? h('div', { className: 'bt-set-row' },
              h('span', { className: 'bt-set-hint bt-danger', role: 'alert' }, t('Could not load local agents.')),
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void load('local-agents') }, t('Try again')))
          : h('div', { className: 'bt-set-row' },
              h('span', { className: 'bt-set-hint', role: 'status' }, t('Checking local agents…')))))
  }
  if (view.available === false) return h('p', { className: 'bt-set-hint' }, t('This DSH cannot register local agent routes.'))
  const profiles = view.profiles ?? []
  const profileCapable = view.detected.filter(agent => agent.supportsProfiles === true)
  const canAddProfile = profileCapable.length > 0
  return [
    h('section', { key: 'found', className: 'bt-set-section', 'data-tour': 'la-detected' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Detected agents')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: refresh }, t('Refresh'))),
      h('div', { className: 'bt-set-card' },
        view.detected.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No agent CLIs found'))) : null,
        view.detected.map(agent => h(AgentSignInRow, { key: agent.route, agent, Row })))),
    canAddProfile || profiles.length > 0 ? h('section', { key: 'profiles', className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Profiles')),
        canAddProfile && editing !== 'profile:new'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'aria-label': t('Add profile'), onClick: () => { setArmedRemove(null); setEditing('profile:new') } }, h(PlusIcon), t('Add profile'))
          : null),
      h('div', { className: 'bt-set-card' },
        profiles.length === 0 && editing !== 'profile:new'
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No profiles added')))
          : null,
        profiles.map(profile => (editing === `profile:${profile.route}`
          ? h(ProfileForm, {
            key: profile.route,
            initial: profile,
            detected: view.detected,
            close: () => setEditing(null),
            submit: payload => call('local-agent-profile-update', payload).then(() => load('local-agents')),
          })
          : h(ProfileRow, {
            key: profile.route,
            profile,
            armed: armedRemove === `profile:${profile.route}`,
            onEdit: () => { setArmedRemove(null); setEditing(`profile:${profile.route}`) },
            onRemove: () => {
              const key = `profile:${profile.route}`
              if (armedRemove !== key) { setArmedRemove(key); return }
              setArmedRemove(null)
              void run(call('local-agent-profile-remove', { route: profile.route })).then(() => load('local-agents'))
            },
            onBlurRemove: () => { if (armedRemove === `profile:${profile.route}`) setArmedRemove(null) },
          }))),
        editing === 'profile:new'
          ? h(ProfileForm, {
            key: 'profile:new',
            detected: profileCapable,
            close: () => setEditing(null),
            submit: payload => call('local-agent-profile-add', payload).then(() => load('local-agents')),
          })
          : null)) : null,
    h('section', { key: 'custom', className: 'bt-set-section' },
      h('div', { className: 'bt-la-sec-head' },
        h('h3', null, t('Custom agents')),
        editing === 'new' ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', 'aria-label': t('Add agent'), 'data-tour': 'la-add', onClick: () => { setArmedRemove(null); setEditing('new') } }, h(PlusIcon), t('Add agent'))),
      h('div', { className: 'bt-set-card' },
        view.custom.length === 0 && editing !== 'new'
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No custom agents yet.')))
          : null,
        view.custom.map(agent => (editing === agent.id
          ? h(AgentForm, { key: agent.id, initial: agent, close: () => setEditing(null), submit: payload => call('local-agent-update', { id: agent.id, ...payload }).then(() => load('local-agents')) })
          : h('div', { key: agent.id, className: 'bt-set-row bt-la-row' },
            h(AgentLogo, { route: agent.route, name: agent.name, size: 32, className: 'bt-cli-logo bt-la-logo' }),
            h('div', { className: 'bt-set-copy bt-la-copy' },
              h('span', { className: 'bt-la-head' }, h('span', { className: 'bt-la-name' }, agent.name)),
              h('span', { className: 'bt-la-path' }, [agent.command, ...(agent.args ?? [])].join(' '))),
            h('div', { className: 'bt-set-control bt-la-actions' },
              h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setArmedRemove(null); setEditing(agent.id) } }, t('Edit')),
              h('button', {
                type: 'button',
                className: armedRemove === agent.id ? 'bt-soft bt-soft-sm bt-danger bt-la-armed' : 'bt-soft bt-soft-sm bt-danger',
                'aria-label': armedRemove === agent.id ? t('Click again to remove') : t('Remove'),
                onClick: () => {
                  if (armedRemove !== agent.id) { setArmedRemove(agent.id); return }
                  setArmedRemove(null)
                  void run(call('local-agent-remove', { id: agent.id })).then(() => load('local-agents'))
                },
                onBlur: () => { if (armedRemove === agent.id) setArmedRemove(null) },
              }, armedRemove === agent.id ? t('Remove?') : h(TrashIcon)))))),
        editing === 'new'
          ? h(AgentForm, { key: 'new', close: () => setEditing(null), submit: payload => call('local-agent-add', payload).then(() => load('local-agents')) })
          : null)),
  ]
}
