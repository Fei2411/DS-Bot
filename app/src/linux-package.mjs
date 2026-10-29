import { readFileSync } from 'node:fs'

/** Prefer the local OS identity; the vendor copy is used only when it is absent. */
export function readOsRelease(read = readFileSync) {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try { return read(file, 'utf8') } catch { /* An update check must still work without this file. */ }
  }
  return ''
}

export function linuxPackageFormat(osRelease) {
  const fields = {}
  for (const line of osRelease.split('\n')) {
    const match = /^(ID|ID_LIKE)=(?:"([^"]*)"|'([^']*)'|([^\s#]*))\s*$/u.exec(line.trim())
    if (match) fields[match[1]] = match[2] ?? match[3] ?? match[4]
  }
  // ID takes precedence; ID_LIKE lists the closest relatives first.
  for (const id of [fields.ID, ...(fields.ID_LIKE ?? '').split(/\s+/u)]) {
    if (['fedora', 'rhel', 'centos', 'suse', 'opensuse', 'opensuse-leap', 'opensuse-tumbleweed'].includes(id)) return 'rpm'
    if (['debian', 'ubuntu'].includes(id)) return 'deb'
  }
  return 'deb'
}

export function linuxPackageAsset(version, format, arch = process.arch) {
  const packageArch = (format === 'rpm' ? { x64: 'x86_64', arm64: 'aarch64' } : { x64: 'amd64' })[arch] ?? arch
  return `DeepSeek-Bot-${version}-linux-${packageArch}.${format}`
}
