// Desktop-only retryable lazy entry for SettingsDialog so Settings code is never parsed
// during cold start, and any transient chunk failure recovers cleanly on retry or reopen.
import { Component, Suspense, createElement as h } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { createChunkLoader, createRetryableLazy } from './retryable-lazy.js'

const LazySettingsDialog = createRetryableLazy(
  createChunkLoader(() => import('../../../ds-bot/src/client/settings.js'), /\/settings(?:-[^/?#]+)?\.js(?:$|[?#])/i),
  mod => mod.SettingsDialog,
)

class SettingsEntryBoundary extends Component {
  state = { failed: false, retryCount: 0 }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('ds-bot: settings dialog failed to load', error)
    noteClientError('settings-entry', error)
    LazySettingsDialog.reset()
  }

  retry() {
    LazySettingsDialog.reset()
    this.setState(prev => ({ failed: false, retryCount: prev.retryCount + 1 }))
  }

  render() {
    if (!this.state.failed) return this.props.children
    const close = () => { this.props.onClose?.() }
    return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: close }),
      h('div', { className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('Settings') },
        h('div', { className: 'dsb-slot-error', role: 'alert', style: { margin: 'auto' } },
          h('span', null, t('This view could not be shown.')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.retry() }, t('Retry')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Close')))))
  }
}

export function SettingsDialog(props) {
  return h(SettingsEntryBoundary, { onClose: props.actions?.closeSettings },
    h(Suspense, { fallback: null }, h(LazySettingsDialog, props)))
}

SettingsDialog.reset = () => { LazySettingsDialog.reset() }
