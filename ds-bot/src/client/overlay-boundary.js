import { Component } from 'react'
import { noteClientError } from './diagnostics.js'
import { t } from './i18n.js'

// Keeps a render failure in one overlay (New chat, panel, menu, dialog, or watcher)
// from bubbling into DSH's SlotErrorBoundary, which would unmount the entire Overlays
// slot until window reload and leave sidebar triggers like "+" unresponsive.
export class OverlayBoundary extends Component {
  state = { failed: false, wasActive: this.props.active !== false, reset: this.props.reset }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props, state) {
    const active = props.active !== false
    const reopened = active && !state.wasActive
    const changed = props.reset !== state.reset
    if (active === state.wasActive && !changed) return null
    return {
      wasActive: active,
      reset: props.reset,
      // A lingering overlay drops to active=false after it crashes and dismisses;
      // reset only on an explicit reopen or an active subject/view change.
      ...(state.failed && (reopened || (active && changed)) ? { failed: false } : {}),
    }
  }

  componentDidCatch(error, info) {
    const name = this.props.name || 'overlay'
    console.error(`ds-bot: overlay '${name}' failed`, error, info?.componentStack ?? '')
    noteClientError(`overlay:${name}`, error)
    try {
      this.props.onDismiss?.()
    } catch (failure) {
      console.error(`ds-bot: failed to dismiss overlay '${name}'`, failure)
    }
    if (this.props.notify !== false) {
      try {
        this.props.actions?.notice?.(t('This view closed because of an error.'))
      } catch (failure) {
        console.error(`ds-bot: failed to notify overlay '${name}'`, failure)
      }
    }
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
