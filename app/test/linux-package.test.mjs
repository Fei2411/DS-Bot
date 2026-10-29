import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linuxPackageAsset, linuxPackageFormat, readOsRelease } from '../src/linux-package.mjs'

test('Linux package selection follows ID, then the closest ID_LIKE family', () => {
  for (const content of ['ID=fedora', 'ID="rhel"', 'ID=centos', 'ID=rocky\nID_LIKE="rhel centos fedora"', "ID=almalinux\nID_LIKE='rhel centos fedora'", 'ID=opensuse-tumbleweed', 'ID=custom\nID_LIKE="suse"']) {
    assert.equal(linuxPackageFormat(content), 'rpm', content)
  }
  for (const content of ['ID=debian', 'ID=ubuntu', 'ID=linuxmint\nID_LIKE="ubuntu debian"', 'ID=debian\nID_LIKE=fedora', 'ID=custom\nID_LIKE="debian fedora"', '', 'ID=arch', 'ID=notfedora', '# ID=fedora\nNAME=Fedora']) {
    assert.equal(linuxPackageFormat(content), 'deb', content)
  }
})

test('OS identity uses the local file first, falls back to vendor, and tolerates missing files', () => {
  const seen = []
  assert.equal(readOsRelease(file => { seen.push(file); return 'ID=fedora' }), 'ID=fedora')
  assert.deepEqual(seen, ['/etc/os-release'])
  assert.equal(readOsRelease(file => {
    if (file === '/etc/os-release') throw new Error('missing')
    assert.equal(file, '/usr/lib/os-release')
    return 'ID=debian'
  }), 'ID=debian')
  assert.equal(readOsRelease(() => { throw new Error('missing') }), '')
})

test('release assets use the package format architecture names', () => {
  assert.equal(linuxPackageAsset('0.2.4', 'rpm', 'x64'), 'DeepSeek-Bot-0.2.4-linux-x86_64.rpm')
  assert.equal(linuxPackageAsset('0.2.4', 'deb', 'x64'), 'DeepSeek-Bot-0.2.4-linux-amd64.deb')
  assert.equal(linuxPackageAsset('0.2.4-rc.1', 'rpm', 'arm64'), 'DeepSeek-Bot-0.2.4-rc.1-linux-aarch64.rpm')
  assert.equal(linuxPackageAsset('0.2.4', 'deb', 'arm64'), 'DeepSeek-Bot-0.2.4-linux-arm64.deb')
})
