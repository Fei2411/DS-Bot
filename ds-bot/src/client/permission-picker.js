import { createElement as h, useEffect, useRef, useState } from 'react'
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
  // One save runs at a time. A pick made while one is in flight waits as `latest`
  // (newer ones overwrite it), so a request that settles cannot clear or reorder a
  // pick made after it; two saves never land out of order on the server.
  const flight = useRef({ value: undefined, latest: undefined })
  useEffect(() => {
    const flying = flight.current.value
    if (pending === saved && (flying === undefined || flying === pending)) setPending(null)
  }, [pending, saved])
  const send = (value) => {
    flight.current.value = value
    void Promise.resolve(onPick(value)).then(done => done !== false, () => false).then((ok) => {
      const wanted = flight.current.latest
      flight.current.latest = undefined
      if (wanted !== undefined && !(wanted === value && ok)) { send(wanted); return }
      flight.current.value = undefined
      if (!ok) setPending(null)
    })
  }
  const current = pending ?? saved
  const pick = (value) => {
    if (value === current && !repick) return
    setPending(value)
    if (flight.current.value !== undefined) { flight.current.latest = value; return }
    send(value)
  }
  return h(Segmented, { label: t('Permissions'), value: current },
    catalog.options.map(option => h('button', {
      key: option.value, type: 'button', 'aria-pressed': option.value === current,
      title: option.description, onClick: () => pick(option.value),
      className: presetDanger(option.value) ? 'bt-perm-danger' : undefined,
    }, presetName(option.value, catalog))))
}
