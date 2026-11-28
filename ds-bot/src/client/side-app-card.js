// The chat card an `open_canvas` / `open_reader` call leaves: which file, and a button
// that opens it again. Everything it needs is in the call's own arguments and result, so
// a card from an earlier part draws the same, and a click reopens it with the host
// proving the file again.
import { createElement as h } from 'react'
import { CanvasIcon, ReaderIcon } from './icons.js'
import { descriptorFromResult } from './side-apps.js'
import { contentText } from './text.js'
import { t } from './i18n.js'

const APPS = { open_canvas: { app: 'canvas', Icon: CanvasIcon, name: 'Canvas app' }, open_reader: { app: 'reader', Icon: ReaderIcon, name: 'Reader app' } }
export const isOpenTool = tool => Object.hasOwn(APPS, tool)

export function SideAppCard({ tool, done, isError, content, arg, sessionId, actions }) {
  const meta = APPS[tool]
  if (!meta) return null
  const descriptor = done && !isError ? descriptorFromResult(contentText(content)) : undefined
  const path = descriptor?.displayPath ?? arg('path') ?? ''
  const failed = done && (isError === true || descriptor === undefined)
  const reopen = () => {
    if (!descriptor) return
    void Promise.resolve(actions.openSideApp(sessionId, descriptor, { reopen: true })).catch(error => actions.reportError?.(error, 'side-app-open'))
  }
  return h('div', { className: 'bt-sapp-card', 'data-failed': failed || undefined, 'data-app': meta.app },
    h('span', { className: 'bt-sapp-card-ico', 'aria-hidden': true }, h(meta.Icon)),
    h('span', { className: 'bt-sapp-card-text' },
      h('span', { className: 'bt-sapp-card-name' }, path.split('/').pop() || t(meta.name)),
      h('span', { className: 'bt-sapp-card-sub' }, failed ? t("Couldn't open {path}", { path }) : done ? path : t('Opening {path}…', { path }))),
    descriptor ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: reopen }, t('Open')) : null)
}
