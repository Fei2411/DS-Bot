// Desktop-only retryable lazy entry for SettingsDialog so Settings code is never parsed
// during cold start, and any transient chunk failure recovers cleanly on retry or reopen.
import { Component, Suspense, createElement as h } from 'react'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { createChunkLoader, createRetryableLazy, reloadWindowSafely } from './retryable-lazy.js'

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

  componentDidMount() {
    this.syncEscapeListener()
  }

  componentDidUpdate(_prevProps, prevState) {
    if (prevState.failed !== this.state.failed) this.syncEscapeListener()
  }

  componentWillUnmount() {
    this.removeEscapeListener()
  }

  onKeyDown = (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      this.props.onClose?.()
    }
  }

  syncEscapeListener() {
    if (this.state.failed) globalThis.addEventListener?.('keydown', this.onKeyDown)
    else this.removeEscapeListener()
  }

  removeEscapeListener() {
    globalThis.removeEventListener?.('keydown', this.onKeyDown)
  }

  retry() {
    this.setState(prev => ({ failed: false, retryCount: prev.retryCount + 1 }))
  }

  reload() {
    if (typeof this.props.onReload === 'function') {
      this.props.onReload()
      return
    }
    reloadWindowSafely()
  }

  render() {
    if (!this.state.failed) return this.props.children
    const close = () => { this.props.onClose?.() }
    const needsReload = this.state.retryCount >= 1
    return h('div', { className: 'bt-settings-layer' },
      h('div', { className: 'bt-scrim', onMouseDown: close }),
      h('div', { className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('Settings') },
        h('div', { className: 'dsb-slot-error', role: 'alert', style: { margin: 'auto' } },
          h('span', null, t('This view could not be shown.')),
          needsReload
            ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.reload() }, t('Reload window'))
            : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => this.retry() }, t('Retry')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: close }, t('Close')))))
  }
}

export function SettingsDialog(props) {
  return h(SettingsEntryBoundary, { onClose: props.actions?.closeSettings },
    h(Suspense, { fallback: null }, h(LazySettingsDialog, props)))
}

SettingsDialog.reset = () => { LazySettingsDialog.reset() }
