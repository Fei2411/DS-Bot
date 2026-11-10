import { createElement as h, useEffect, useState } from 'react'
import { CheckIcon } from './icons.js'
import { call } from './api.js'
import { t } from './i18n.js'

// The engine's plugin manager: the profile's plugin packages and the official catalog.
// A switch saves the profile patch through the host; a host with no plugin manager says
// so instead of showing an empty list.
export function PluginsPage({ run, Section, Row, Switch }) {
  const [view, setView] = useState(null)
  const load = () => run(call('plugins').then(setView))
  useEffect(() => { void load() }, [])
  if (view === null) return null
  if (view.available === false) return h('p', { className: 'bt-set-hint' }, t('This host has no plugin manager.'))
  const update = endpoint => payload => run(call(endpoint, payload).then(setView))
  const setBundle = update('plugin-bundle')
  const install = update('plugin-install')
  const hintOf = row => [row.description, row.problem, row.readOnlyReason, row.version === null ? undefined : `v${row.version}`].filter(Boolean).join(' · ') || undefined
  const toggle = bundle => h(Switch, {
    on: bundle.enabled, label: bundle.title, disabled: !bundle.selectable,
    onChange: enabled => setBundle({ name: bundle.name, enabled }),
  })
  const installed = view.bundles.filter(bundle => bundle.enabled || bundle.installed)
  const catalog = view.bundles.filter(bundle => !bundle.enabled && !bundle.installed)
  return [
    h(Section, { key: 'installed', title: t('Installed plugins') },
      installed.length === 0 ? h(Row, { key: 'none', label: t('No plugins are installed') }) : null,
      installed.map(bundle => h(Row, { key: bundle.name, label: bundle.title, hint: hintOf(bundle) }, toggle(bundle))),
      h(Row, { key: 'refresh', label: t('Refresh') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Refresh'), onClick: () => load() }, h(CheckIcon)))),
    h(Section, { key: 'catalog', title: t('Official catalog') },
      catalog.filter(bundle => bundle.official).map(bundle => h(Row, {
        key: bundle.name, label: bundle.title, hint: hintOf(bundle),
      },
      bundle.installable
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => install({ name: bundle.name }) }, t('Install'))
        : bundle.selectable
          ? toggle(bundle)
          : h('span', { className: 'bt-tag' }, t('Not available here'))))),
  ]
}
