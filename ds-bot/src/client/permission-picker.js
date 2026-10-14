import { createElement as h, useEffect, useState } from 'react'
import { Segmented } from './motion.js'
import { t } from './i18n.js'

const LABELS = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access' }
const DANGER = new Set(['danger-full-access'])

export const presetDanger = value => DANGER.has(value)
export const presetName = (value, catalog) => (LABELS[value] ? t(LABELS[value]) : catalog?.options?.find(option => option.value === value)?.name ?? value)

// The presets DeepSeek Harness offers, as one segmented choice. A pick shows at once
// and holds until the saved value catches up, or falls back when `onPick` resolves
// false. `repick` lets the shown preset be picked again.
export function PermissionPicker({ catalog, saved, onPick, repick = false }) {
  const [pending, setPending] = useState(null)
  useEffect(() => { if (pending === saved) setPending(null) }, [pending, saved])
  const current = pending ?? saved
  const pick = (value) => {
    if (value === current && !repick) return
    setPending(value)
    void Promise.resolve(onPick(value)).then((done) => { if (done === false) setPending(null) })
  }
  return h(Segmented, { label: t('Permissions'), value: current },
    catalog.options.map(option => h('button', {
      key: option.value, type: 'button', 'aria-pressed': option.value === current,
      title: option.description, onClick: () => pick(option.value),
      className: presetDanger(option.value) ? 'bt-perm-danger' : undefined,
    }, presetName(option.value, catalog))))
}
