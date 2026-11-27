import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ABOUT_CSS } from '../../../ds-bot/src/client/about.js'
import { AGENT_CARDS_CSS } from '../../../ds-bot/src/client/agent-cards.js'
import { AVATAR_LIBRARY_CSS } from '../../../ds-bot/src/client/avatar-library.js'
import { BOT_MODELS_CSS } from '../../../ds-bot/src/client/bot-models-page.js'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.js'
import { TASKS_CSS } from '../../../ds-bot/src/client/bot-tasks.js'
import { BROWSER_CSS } from '../../../ds-bot/src/client/browser-pane.js'
import { CHANGES_CSS } from '../../../ds-bot/src/client/changes-card.js'
import { COMPUTER_CSS } from '../../../ds-bot/src/client/computer.js'
import { CONNECTOR_CSS } from '../../../ds-bot/src/client/connectors.js'
import { CONNECTORS_PAGE_CSS } from '../../../ds-bot/src/client/connectors-page.js'
import { FEEDBACK_CSS } from '../../../ds-bot/src/client/feedback.js'
import { FOLDER_CSS } from '../../../ds-bot/src/client/folder-menu.js'
import { GOAL_CSS } from '../../../ds-bot/src/client/goal.js'
import { GROUP_SETTINGS_CSS } from '../../../ds-bot/src/client/group-settings.js'
import { HANDOFF_CSS } from '../../../ds-bot/src/client/handoff-card.js'
import { installLocale } from '../../../ds-bot/src/client/i18n.js'
import { IM_CSS } from '../../../ds-bot/src/client/im-page.js'
import { LEARNING_CSS } from '../../../ds-bot/src/client/learning-card.js'
import { MEMBER_CSS } from '../../../ds-bot/src/client/member-status.js'
import { MODEL_CSS } from '../../../ds-bot/src/client/model-menu.js'
import { installMotionRest } from '../../../ds-bot/src/client/motion-rest.js'
import { OPENING_CSS } from '../../../ds-bot/src/client/opening.js'
import { PASTE_CSS } from '../../../ds-bot/src/client/paste-card.js'
import { PRIVACY_CSS } from '../../../ds-bot/src/client/privacy-page.js'
import { PROVIDERS_CSS } from '../../../ds-bot/src/client/providers-page.js'
import { QUEUE_CSS } from '../../../ds-bot/src/client/queue-dock.js'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.js'
import { APPEARANCE_PAGE_CSS } from '../../../ds-bot/src/client/appearance-page.js'
import { SHORTCUTS_PAGE_CSS } from '../../../ds-bot/src/client/shortcuts-page.js'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.js'
import { SERVICES_CSS } from '../../../ds-bot/src/client/services-settings.js'
import { SIDE_CSS } from '../../../ds-bot/src/client/side-chat.js'
import { RETURN_CSS, SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.js'
import { INBOX_CSS } from '../../../ds-bot/src/client/inbox.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.js'
import { TASK_CSS } from '../../../ds-bot/src/client/task-board.js'
import { ANNOTATION_CSS } from '../../../ds-bot/src/client/text-annotation.js'
import { TURN_ERROR_CSS } from '../../../ds-bot/src/client/turn-error.js'
import { USAGE_CSS } from '../../../ds-bot/src/client/usage-page.js'
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
import './app.css'
import './composer-classic.css'
import './message-parity.css'

registerMathStyleLoader(() => import('katex/dist/katex.min.css'))

const appLocale = createLocale(navigator.language)
setAppLocaleService(appLocale)
installLocale(appLocale)
installMotionRest()
pluginRuntime.provide('slots', slots)
pluginRuntime.use({ id: 'ds-bot.builtin-tool-views', name: 'Built-in tool views', pages: ['chat'] }, () => registerBuiltinToolViews(slots))
pluginRuntime.use({ id: 'ds-bot.classic-plan-view', name: 'Classic plan card', pages: ['chat'] }, () => registerClassicPlanView(slots))
registerEngineSettingsPlugin(pluginRuntime, { pages: ['settings'] })
globalThis.dsBotPlugins = pluginRuntime
document.documentElement.lang = appLocale.getLocale().active
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS + RETURN_CSS + INBOX_CSS],
  ['conversation', CONVERSATION_CSS + PASTE_CSS + OPENING_CSS + USER_MESSAGE_CSS + WIDGET_CSS + CHANGES_CSS + HANDOFF_CSS + TURN_ERROR_CSS + QUEUE_CSS + ANNOTATION_CSS],
  ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS + SERVICES_CSS], ['connectors', CONNECTOR_CSS + CONNECTORS_PAGE_CSS + IM_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + BOT_MODELS_CSS + AGENT_CARDS_CSS + AVATAR_LIBRARY_CSS + GROUP_SETTINGS_CSS],
  ['panel', BROWSER_CSS + COMPUTER_CSS + SIDE_CSS + GOAL_CSS + TASK_CSS + TASKS_CSS + LEARNING_CSS],
  ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS], ['appearance', APPEARANCE_PAGE_CSS], ['shortcuts', SHORTCUTS_PAGE_CSS],
  ['feedback', FEEDBACK_CSS], ['privacy', PRIVACY_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS],
]) installStyles(text, tag)

// Light or dark before the team arrives; then the team's choice (mode.js).
paintMode(undefined)

createRoot(document.getElementById('root')).render(h(App))
