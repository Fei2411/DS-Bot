import { language, t } from './i18n.js'
import { toTraditional } from './locales/zh-tw.js'

const ESCALATION_PREFIX = /^(?:Allow this operation with danger-full-access permissions:|escalate sandbox to danger-full-access:)\s*/i

/**
 * Resolves the localized approval reason from `entry.displayReason` if present,
 * falling back cleanly to `entry.reason`.
 */
export function resolveApprovalReason(entry, lang = language()) {
  const map = entry?.displayReason
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const raw = String(lang ?? 'en').toLowerCase()
    const base = raw.split('-')[0]
    if (typeof map[lang] === 'string' && map[lang].trim() !== '') return map[lang]
    if (typeof map[raw] === 'string' && map[raw].trim() !== '') return map[raw]
    if ((raw === 'zh-tw' || raw === 'zh-hk' || raw === 'zh-hant') && typeof map.zh === 'string' && map.zh.trim() !== '') {
      return toTraditional(map.zh)
    }
    if (typeof map[base] === 'string' && map[base].trim() !== '') return map[base]
    if (typeof map.en === 'string' && map.en.trim() !== '') return map.en
  }
  return typeof entry?.reason === 'string' && entry.reason.trim() !== '' ? entry.reason : ''
}

/**
 * Returns the localized, cleaned approval reason, omitting boilerplate escalation prefixes
 * and avoiding exact duplication with an already-shown detail or title line.
 */
export function cleanApprovalReason(entry, duplicateText = '', lang = language()) {
  const raw = resolveApprovalReason(entry, lang)
  const clean = raw.replace(ESCALATION_PREFIX, '').trim()
  if (!clean) return ''
  return clean === String(duplicateText ?? '').trim() ? '' : clean
}

/**
 * Human-readable scope summary explaining what "Always allow" will persist
 * (distinguishing Bot scope from Group scope).
 */
export function alwaysAllowScopeLabel(alwaysAllow) {
  if (!alwaysAllow || typeof alwaysAllow !== 'object') return ''
  if (alwaysAllow.kind === 'extra-dir' && Array.isArray(alwaysAllow.dirs) && alwaysAllow.dirs.length > 0) {
    const first = alwaysAllow.dirs[0]
    if (alwaysAllow.scope === 'group') {
      return alwaysAllow.dirs.length === 1
        ? t('Always allow this group to edit files in {dir}', { dir: first })
        : t('Always allow this group to edit files in {dir} (+{count})', { dir: first, count: alwaysAllow.dirs.length - 1 })
    }
    return alwaysAllow.dirs.length === 1
      ? t('Always allow file edits in {dir}', { dir: first })
      : t('Always allow file edits in {dir} (+{count})', { dir: first, count: alwaysAllow.dirs.length - 1 })
  }
  return ''
}
