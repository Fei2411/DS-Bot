// Plugin status codes come from the engine and mean something to the manager, not to the
// user. The page turns them into one sentence in the interface language: the codes it
// knows get their own wording, any other code gets a plain "cannot be used here" instead
// of the raw identifier leaking into the hint.
import { t } from './i18n.js'

const READ_ONLY = 'management-required'

export function pluginStatusText(code) {
  return String(code) === READ_ONLY
    ? t('Managed by the installation. It cannot be switched here.')
    : t('This plugin cannot be used here.')
}
