// The Canvas App: a workspace HTML file as an interactive sandboxed preview, its source,
// and what changed. The page runs in an iframe with scripts but no same-origin access;
// the host serves it (and the assets beside it) only to the ticket in `frameUrl`.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { useHostBase, usePreview, useWorkspaceFile } from './side-file-source.js'
import { DiffView, FileEmpty, ModeSwitch, SourceView, StatusLine, diffCount } from './side-file-views.js'
import { PanelMenu } from './browser-pane.js'
import { CopyIcon, RefreshIcon } from './icons.js'
import { reducedMotion } from './motion.js'
import { writeClipboard } from './dsh-primitives.js'
import { t } from './i18n.js'

// Scripts run because a draft is meant to be interactive; form submission, downloads,
// popups, top navigation and same-origin access stay off (V1 plan §5).
export const CANVAS_SANDBOX = 'allow-scripts'
export const DEVICES = [['fit', 'Fit', null], ['phone', 'Phone', 390], ['tablet', 'Tablet', 768]]
// Writes that land this close together are one reload.
const SWAP_MS = 400
const FADE_MS = 140

/** The address the frame loads: the ticketed entry plus the revision that made it new. */
export const frameSrc = (frameUrl, revision) => (frameUrl ? `${frameUrl}${frameUrl.includes('?') ? '&' : '?'}r=${encodeURIComponent(revision ?? '')}` : '')

// Two frames take turns: the next page loads out of sight and takes over once it has
// loaded, so a refresh never flashes white. Page state inside the frame is lost.
function PreviewFrames({ src, title, width, live }) {
  const [shown, setShown] = useState(src)
  const [next, setNext] = useState(null)
  const [fade, setFade] = useState(false)
  const timer = useRef(null)
  const fadeTimer = useRef(null)
  useEffect(() => {
    if (src === shown) { setNext(null); return undefined }
    if (!live && shown !== '') return undefined
    clearTimeout(timer.current)
    // The first page is not delayed; later ones wait out a burst of writes.
    timer.current = setTimeout(() => setNext(src), shown === '' ? 0 : SWAP_MS)
    return () => clearTimeout(timer.current)
  }, [src, live])
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(fadeTimer.current) }, [])
  const take = () => {
    setShown(next)
    setNext(null)
    if (reducedMotion()) return
    setFade(true)
    clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => setFade(false), FADE_MS)
  }
  const style = width ? { width: `${width}px` } : undefined
  const frame = (url, props) => h('iframe', {
    key: url, src: url, title, sandbox: CANVAS_SANDBOX, referrerPolicy: 'no-referrer', loading: 'eager',
    className: 'bt-sapp-frame', style, ...props,
  })
  return h('div', { className: 'bt-sapp-stage', 'data-fit': width ? undefined : '' },
    shown ? frame(shown, { 'data-fade': fade || undefined }) : null,
    next ? frame(next, { 'aria-hidden': true, tabIndex: -1, className: 'bt-sapp-frame bt-sapp-frame-next', onLoad: take }) : null)
}

export function CanvasView({ tab, mode, onMode, visible }) {
  const [live, setLive] = useState(true)
  const [device, setDevice] = useState('fit')
  const rendering = mode === 'preview'
  // The text is read while the tab is on screen even under Render: the first read is
  // the Changes baseline, and the Changes count needs the text. Live pauses both reads
  // and the preview; Refresh still works.
  const file = useWorkspaceFile(tab, visible && live)
  const preview = usePreview(tab, visible && rendering && live)
  const host = useHostBase(tab, file.revision, mode === 'diff')
  const ready = file.status === 'ready' || typeof file.text === 'string'
  const width = DEVICES.find(([id]) => id === device)?.[2] ?? null
  const copyPath = () => { void writeClipboard(tab.displayPath) }
  const refresh = () => { void preview.refresh(); void file.refresh() }
  const items = [
    { key: 'copy', icon: CopyIcon, label: t('Copy path'), onPick: copyPath },
  ]
  const frameTitle = t('Canvas preview of {path}', { path: tab.displayPath })
  let body
  if (mode === 'source') {
    body = ready ? h(SourceView, { text: file.text, label: t('Source of {path}', { path: tab.displayPath }) }) : h(FileEmpty, { status: file.status, path: tab.displayPath, message: file.error?.message, onRetry: file.refresh })
  } else if (mode === 'diff') {
    body = ready ? h(DiffView, { file, host, onReviewed: file.markReviewed }) : h(FileEmpty, { status: file.status, path: tab.displayPath, message: file.error?.message, onRetry: file.refresh })
  } else if (preview.status === 'unavailable') {
    body = h('div', { className: 'bt-sapp-empty' },
      h('div', { className: 'bt-sapp-empty-title' }, t("This page can't be previewed")),
      h('div', { className: 'bt-sapp-empty-note' }, preview.unavailable || t('The source view still works.')),
      h('button', { type: 'button', className: 'bt-soft', onClick: () => onMode('source') }, t('Show source')))
  } else if (preview.frameUrl) {
    body = h(PreviewFrames, { src: frameSrc(preview.frameUrl, preview.previewRevision), title: frameTitle, width, live })
  } else {
    body = h(FileEmpty, { status: preview.status, path: tab.displayPath, message: preview.error?.message, onRetry: preview.refresh })
  }
  const failed = rendering ? preview.status === 'error' || preview.status === 'missing' : false
  const statusFile = rendering
    ? { status: preview.status === 'ready' ? 'ready' : preview.status, updatedAt: file.updatedAt }
    : file
  return h('div', { className: 'bt-panel-view bt-sapp', 'data-app': 'canvas' },
    h('div', { className: 'bt-sapp-bar' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Refresh'), title: t('Refresh'), onClick: refresh }, h(RefreshIcon)),
      h(ModeSwitch, { app: 'canvas', mode, onMode, changes: diffCount(file, host) }),
      rendering ? h('span', { className: 'bt-sapp-devices', role: 'group', 'aria-label': t('Width') },
        DEVICES.map(([id, label]) => h('button', {
          key: id, type: 'button', className: 'bt-sapp-device', 'aria-pressed': device === id, onClick: () => setDevice(id),
        }, t(label)))) : null,
      rendering ? h('button', {
        type: 'button', className: 'bt-sapp-live', 'aria-pressed': live, title: t('Refresh the preview by itself when the file changes'),
        onClick: () => setLive(value => !value),
      }, h('span', { className: 'bt-sapp-live-dot', 'aria-hidden': true }), t('Live')) : null,
      h(PanelMenu, { items, className: 'bt-icon-btn', 'aria-label': t('More') })),
    h(StatusLine, { file: statusFile, path: tab.displayPath, extra: failed ? h('button', { type: 'button', className: 'bt-sapp-retry', onClick: refresh }, t('Try again')) : null }),
    h('div', { className: 'bt-sapp-body' }, body))
}
