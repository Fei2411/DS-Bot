import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ABOUT_CSS } from '../../../ds-bot/src/client/about.js'
import { AGENT_CARDS_CSS } from '../../../ds-bot/src/client/agent-cards.js'
import { AVATAR_LIBRARY_CSS } from '../../../ds-bot/src/client/avatar-library.js'
import { BOT_MODELS_CSS } from '../../../ds-bot/src/client/bot-models-page.js'
import { BOT_SETTINGS_CSS } from '../../../ds-bot/src/client/bot-settings.js'
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
import { PROVIDERS_CSS } from '../../../ds-bot/src/client/providers-page.js'
import { QUEUE_CSS } from '../../../ds-bot/src/client/queue-dock.js'
import { READ_ONLY_CSS } from '../../../ds-bot/src/client/read-only-dock.js'
import { SCHEDULE_CSS } from '../../../ds-bot/src/client/schedules.js'
import { SECRET_CSS } from '../../../ds-bot/src/client/secret-card.js'
import { SIDE_CSS } from '../../../ds-bot/src/client/side-chat.js'
import { SIDEBAR_CSS } from '../../../ds-bot/src/client/sidebar.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../ds-bot/src/client/styles.js'
import { TASK_CSS } from '../../../ds-bot/src/client/task-board.js'
import { ANNOTATION_CSS } from '../../../ds-bot/src/client/text-annotation.js'
import { TURN_ERROR_CSS } from '../../../ds-bot/src/client/turn-error.js'
import { USAGE_CSS } from '../../../ds-bot/src/client/usage-page.js'
import { USER_MESSAGE_CSS } from '../../../ds-bot/src/client/user-message.js'
import { WIDGET_CSS } from '../../../ds-bot/src/client/widget-cell.js'
import { createLocale } from './locale.js'
import { App } from './app.js'
import './app.css'

installLocale(createLocale(navigator.language))
installMotionRest()
document.documentElement.lang = navigator.language
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS],
  ['conversation', CONVERSATION_CSS + READ_ONLY_CSS + PASTE_CSS + OPENING_CSS + USER_MESSAGE_CSS + WIDGET_CSS + CHANGES_CSS + HANDOFF_CSS + TURN_ERROR_CSS + QUEUE_CSS + ANNOTATION_CSS],
  ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS], ['connectors', CONNECTOR_CSS + CONNECTORS_PAGE_CSS + IM_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + BOT_MODELS_CSS + AGENT_CARDS_CSS + AVATAR_LIBRARY_CSS + GROUP_SETTINGS_CSS],
  ['panel', BROWSER_CSS + COMPUTER_CSS + SIDE_CSS + GOAL_CSS + TASK_CSS + LEARNING_CSS],
  ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS],
]) installStyles(text, tag)

// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the system's
// light or dark mode sets it.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
paint()
dark.addEventListener('change', paint)

createRoot(document.getElementById('root')).render(h(App))
