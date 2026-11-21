import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'

let hooks: ReturnType<typeof registerHooks>
let ensureUnlock: (endpoint: string) => Promise<void>
const auth = { level: 1, success: true, prompts: 0 }

before(async () => {
  ;(globalThis as any).__gateTestAuth = auth
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'expo-local-authentication' || specifier === '../ui/i18n.ts') return { url: `gate-test:${specifier}`, shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'gate-test:expo-local-authentication') return { format: 'module', shortCircuit: true, source: `
        export const SecurityLevel = { NONE: 0 }
        export const getEnrolledLevelAsync = async () => globalThis.__gateTestAuth.level
        export const authenticateAsync = async () => {
          globalThis.__gateTestAuth.prompts += 1
          return { success: globalThis.__gateTestAuth.success }
        }
      ` }
      if (url === 'gate-test:../ui/i18n.ts') return { format: 'module', shortCircuit: true, source: 'export const t = text => text' }
      return nextLoad(url, context)
    },
  })
  ;({ ensureUnlock } = await import('./gate.ts'))
})

after(() => {
  hooks.deregister()
  delete (globalThis as any).__gateTestAuth
})

test('learning answers require device unlock, including cancellation and no screen lock', async () => {
  await ensureUnlock('state')
  assert.equal(auth.prompts, 0)
  await ensureUnlock('learning-answer')
  assert.equal(auth.prompts, 1)
  auth.success = false
  await assert.rejects(ensureUnlock('learning-answer'), { code: 'unlock/canceled' })
  assert.equal(auth.prompts, 2)
  auth.level = 0
  await assert.rejects(ensureUnlock('learning-answer'), { code: 'unlock/unavailable' })
  assert.equal(auth.prompts, 2)
})
