// Which machine a request is about. A Bot chooses the node itself; this helper only
// narrows the choice from the words the user used, so "open C:\\Users\\me\\report.docx"
// lands on the Windows machine and "/Users/me/notes.md" on the Mac. It never invents a
// machine: with no clear match it returns undefined and the Bot asks.

const WINDOWS_HINT = /(^|[\s"'(])(\\\\|\\\\[^\\]|[A-Za-z]:[\\/])|\.(exe|bat|cmd|ps1|msi)\b|\bwin(dows)?\b|\bpowershell\b/i
const MAC_HINT = /\/Users\/|\/Applications\/|\/Volumes\/|\.app\b|\bmac\s?(os|mini|book|studio)\b|\bdarwin\b/i
const LINUX_HINT = /\blinux\b|\bubuntu\b|\bdebian\b|\/home\/[^/]+\b|\/etc\//i

export function hintOs(text) {
  const value = String(text ?? '')
  if (WINDOWS_HINT.test(value)) return 'win32'
  if (MAC_HINT.test(value)) return 'darwin'
  if (LINUX_HINT.test(value)) return 'linux'
  return undefined
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentions = (text, value) => {
  const needle = String(value ?? '').trim()
  if (needle.length < 2) return false
  return new RegExp(`(^|[^a-z0-9_-])${escape(needle.toLowerCase())}([^a-z0-9_-]|$)`, 'i').test(text)
}

// The machine a hint names, offline ones included: used when explaining a choice, so
// "the Windows PC" can be told apart from "a Mac". A named host or machine wins over
// an OS guess.
export function hintedDevice(nodes, hint) {
  const list = nodes ?? []
  const text = String(hint ?? '').toLowerCase()
  const byHost = list.find(node => mentions(text, node.hostname))
  if (byHost !== undefined) return byHost
  const byName = list.find(node => mentions(text, node.name))
  if (byName !== undefined) return byName
  const wanted = hintOs(hint)
  return wanted === undefined ? undefined : list.find(node => node.os === wanted)
}

// The best online machine for a hint, or undefined when the hint does not decide.
// Online only: an offline machine cannot run the task, and the Bot must say so rather
// than queue work nobody will see. A hint that names an OS is not overridden by a lone
// machine of another OS: a Windows path belongs on Windows, not on the only Mac online.
export function bestDevice(nodes, hint) {
  const online = (nodes ?? []).filter(node => node.online === true)
  if (online.length === 0) return undefined
  const text = String(hint ?? '').toLowerCase()
  const byHost = online.find(node => mentions(text, node.hostname))
  if (byHost !== undefined) return byHost
  const byName = online.find(node => mentions(text, node.name))
  if (byName !== undefined) return byName
  const wanted = hintOs(hint)
  if (wanted !== undefined) return online.find(node => node.os === wanted)
  return online.length === 1 ? online[0] : undefined
}
