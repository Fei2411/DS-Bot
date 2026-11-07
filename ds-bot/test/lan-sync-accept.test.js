import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mockModel, pickDevice, redact } from '../dev/lan-sync-accept.mjs'

// The rule list_devices/run_on_device describe to the Bot, as the acceptance script
// implements it for an unattended run.
test('auto-pick never chooses an offline machine and prefers Windows', () => {
  const nodes = [
    { id: 'nd_1', name: 'mac-mini', online: true, os: 'darwin', hostname: 'studio-mac' },
    { id: 'nd_2', name: 'windows-pc', online: false, os: 'win32', hostname: 'DESKTOP-BNUICR3' },
    { id: 'nd_3', name: 'windows-laptop', online: true, os: 'win32', hostname: 'DESKTOP-OTHER' },
  ]
  assert.equal(pickDevice(nodes).id, 'nd_3')
  assert.equal(pickDevice(nodes.filter(node => node.online)).id, 'nd_3')
  assert.equal(pickDevice([]), undefined)
})

test('auto-pick uses a DESKTOP hostname, then the first online machine', () => {
  const desktop = { id: 'nd_1', name: 'pc', online: true, os: 'freebsd', hostname: 'DESKTOP-BNUICR3' }
  const other = { id: 'nd_2', name: 'mac', online: true, os: 'darwin', hostname: 'studio-mac' }
  assert.equal(pickDevice([other, desktop]).id, 'nd_1')
  assert.equal(pickDevice([other]).id, 'nd_2')
})

test('the mock model is the DeepSeek route, not a local agent', () => {
  const models = [
    { ref: 'gemini-cli/default' },
    { ref: 'deepseek-official/deepseek-flash' },
    { ref: 'deepseek-official/deepseek-v4-pro' },
  ]
  assert.equal(mockModel(models).ref, 'deepseek-official/deepseek-flash')
  assert.equal(mockModel([{ ref: 'gemini-cli/default' }]), undefined)
  assert.equal(mockModel([]), undefined)
})

test('a launch URL never keeps its token in output', () => {
  const line = 'dsh web: http://192.168.1.20:3080/?token=abcdef123456 and again token=zzz'
  assert.equal(redact(line), 'dsh web: http://192.168.1.20:3080/?token=<redacted> and again token=<redacted>')
})
