import { Fragment, createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AGENT_CARDS_CSS } from '../../../ds-bot/src/client/agent-cards.js'
import { AVATAR_LIBRARY_CSS } from '../../../ds-bot/src/client/avatar-library.js'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.js'
import { TASKS_CSS } from '../../../ds-bot/src/client/bot-tasks.js'
import { BROWSER_CSS } from '../../../ds-bot/src/client/browser-pane.js'
import { CHANGES_CSS } from '../../../ds-bot/src/client/changes-card.js'
import { COMPUTER_CSS } from '../../../ds-bot/src/client/computer.js'
import { CONNECTOR_CSS } from '../../../ds-bot/src/client/connectors.js'
import { noteClientError } from '../../../ds-bot/src/client/diagnostics.js'
import { FEEDBACK_CSS } from '../../../ds-bot/src/client/feedback.js'
import { FOLDER_CSS } from '../../../ds-bot/src/client/folder-menu.js'
import { GOAL_CSS } from '../../../ds-bot/src/client/goal.js'
import { GROUP_SETTINGS_CSS } from '../../../ds-bot/src/client/group-settings.js'
import { HANDOFF_CSS } from '../../../ds-bot/src/client/handoff-card.js'
import { ensureLocale, installLocale } from '../../../ds-bot/src/client/i18n.js'
import { LEARNING_CSS } from '../../../ds-bot/src/client/learning-card.js'
import { MEMBER_CSS } from '../../../ds-bot/src/client/member-status.js'
import { MODEL_CSS } from '../../../ds-bot/src/client/model-menu.js'
import { installMotionRest } from '../../../ds-bot/src/client/motion-rest.js'
import { OPENING_CSS } from '../../../ds-bot/src/client/opening.js'
import { PASTE_CSS } from '../../../ds-bot/src/client/paste-card.js'
import { PRIVACY_CSS } from '../../../ds-bot/src/client/privacy-page.js'
import { QUEUE_CSS } from '../../../ds-bot/src/client/queue-dock.js'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.js'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.js'
import { SIDE_CSS } from '../../../ds-bot/src/client/side-chat.js'
import { RETURN_CSS, SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.js'
import { INBOX_CSS } from '../../../ds-bot/src/client/inbox.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.js'
import { UI_CSS } from '../../../ds-bot/src/client/ui/index.js'
import { TASK_CSS } from '../../../ds-bot/src/client/task-board.js'
import { ANNOTATION_CSS } from '../../../ds-bot/src/client/text-annotation.js'
import { TURN_ERROR_CSS } from '../../../ds-bot/src/client/turn-error.js'
import { USER_MESSAGE_CSS } from '../../../ds-bot/src/client/user-message.js'
import { WIDGET_CSS } from '../../../ds-bot/src/client/widget-cell.js'
import { createLocale, setAppLocaleService } from './locale.js'
import { App } from './app.js'
import { registerBuiltinToolViews } from './builtin-tool-views.js'
import { registerClassicPlanView } from './classic-plan-view.js'
import { registerEngineSettingsPlugin } from './engine-settings-bridge.js'
import { registerMathStyleLoader } from './math-render.js'
import { paintMode } from './mode.js'
import { pluginRuntime } from './plugin-runtime.js'
import { slots } from './slots.js'
import { loadExternalUiPlugins } from './ui-plugin-loader.js'
import './app.css'
import './composer-classic.css'
import './message-parity.css'

registerMathStyleLoader(() => import('katex/dist/katex.min.css'))

// Keep liveSystemTag empty until main-process IPC reports an OS language so browser
// `navigator.language` updates on `languagechange` are never shadowed when IPC is absent.
let liveSystemTag = ''
const refreshSystemTag = typeof globalThis.dsBotApp?.systemLanguage === 'function'
  ? () => Promise.resolve(globalThis.dsBotApp.systemLanguage()).then((tag) => {
    if (typeof tag === 'string' && tag.trim() !== '') liveSystemTag = tag
    return tag
  }).catch(() => undefined)
  : null
const appLocale = createLocale(navigator.language, {
  getSystemTag: () => liveSystemTag || navigator.language,
  refreshSystemTag,
})
globalThis.dsBotApp?.onSystemLanguage?.((tag) => {
  if (typeof tag !== 'string' || tag.trim() === '') return
  liveSystemTag = tag
  appLocale.syncSystemTag(tag)
})
setAppLocaleService(appLocale)
installLocale(appLocale, {
  onError: (_lang, err) => { noteClientError('i18n-load', err) },
})
installMotionRest()
pluginRuntime.provide('slots', slots)
pluginRuntime.provide('react', Object.freeze({ createElement: h, Fragment, useState, useEffect, useMemo, useCallback, useRef }))
pluginRuntime.use({ id: 'ds-bot.builtin-tool-views', name: 'Built-in tool views', pages: ['chat'] }, () => registerBuiltinToolViews(slots))
pluginRuntime.use({ id: 'ds-bot.classic-plan-view', name: 'Classic plan card', pages: ['chat'] }, () => registerClassicPlanView(slots))
registerEngineSettingsPlugin(pluginRuntime, { pages: ['settings'] })
void loadExternalUiPlugins(pluginRuntime)
globalThis.dsBotPlugins = pluginRuntime
document.documentElement.lang = appLocale.getLocale().active
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
// Settings-only stylesheets install lazily alongside their pages (`settings-pages-lazy.js`).
for (const [tag, text] of [
  ['shell', SHELL_CSS + UI_CSS], ['sidebar', SIDEBAR_CSS + RETURN_CSS + INBOX_CSS],
  ['conversation', CONVERSATION_CSS + PASTE_CSS + OPENING_CSS + USER_MESSAGE_CSS + WIDGET_CSS + CHANGES_CSS + HANDOFF_CSS + TURN_ERROR_CSS + QUEUE_CSS + ANNOTATION_CSS],
  ['secrets', SECRET_CSS], ['connectors', CONNECTOR_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + AGENT_CARDS_CSS + AVATAR_LIBRARY_CSS + GROUP_SETTINGS_CSS],
  ['panel', BROWSER_CSS + COMPUTER_CSS + SIDE_CSS + GOAL_CSS + TASK_CSS + TASKS_CSS + LEARNING_CSS],
  ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['privacy', PRIVACY_CSS], ['members', MEMBER_CSS],
]) installStyles(text, tag)

// Light or dark before the team arrives; then the team's choice (mode.js).
paintMode(undefined)

const root = createRoot(document.getElementById('root'))
const INITIAL_SYSTEM_LANG_WAIT_MS = 150
const INITIAL_LOCALE_WAIT_MS = 800
const initialSystemLanguage = refreshSystemTag
  ? (() => {
    let timer = null
    return Promise.race([
      refreshSystemTag().then((tag) => {
        if (typeof tag === 'string' && tag.trim() !== '') appLocale.syncSystemTag(tag)
      }),
      new Promise((resolve) => { timer = setTimeout(resolve, INITIAL_SYSTEM_LANG_WAIT_MS) }),
    ]).finally(() => { if (timer !== null) clearTimeout(timer) })
  })()
  : Promise.resolve()

void initialSystemLanguage.then(() => {
  const initialLang = appLocale.getLocale().active
  let localeTimer = null
  const initialLoad = ensureLocale(initialLang).catch((err) => {
    console.error(`ds-bot: failed to load initial locale "${initialLang}"`, err)
    noteClientError('i18n-load', err)
  })
  return Promise.race([
    initialLoad,
    new Promise((resolve) => { localeTimer = setTimeout(resolve, INITIAL_LOCALE_WAIT_MS) }),
  ]).finally(() => { if (localeTimer !== null) clearTimeout(localeTimer) })
}).finally(() => {
  document.documentElement.lang = appLocale.getLocale().active
  root.render(h(App))
})
