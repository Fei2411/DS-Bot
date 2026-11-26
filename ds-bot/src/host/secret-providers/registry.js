// Registry for external secret providers (e.g. 1Password `op://`).
// Each driver implements:
//   { kind, label, isReference(str), validateConfig(cfg), readBatch(config, refs, signal) }
import { createOnePasswordDriver } from './onepassword.js'

export function createProviderRegistry(drivers = []) {
  /** @type {Map<string, any>} */
  const byKind = new Map()

  function register(driver) {
    if (!driver || typeof driver.kind !== 'string' || driver.kind === '') {
      throw new Error('Secret provider driver requires a non-empty kind.')
    }
    if (typeof driver.isReference !== 'function' || typeof driver.readBatch !== 'function') {
      throw new Error(`Secret provider driver "${driver.kind}" must implement isReference() and readBatch().`)
    }
    byKind.set(driver.kind, driver)
    return driver
  }

  for (const driver of drivers) register(driver)

  return {
    register,
    get: kind => byKind.get(kind),
    list: () => [...byKind.values()].map(driver => ({ kind: driver.kind, label: driver.label ?? driver.kind })),
    findForReference(value) {
      if (typeof value !== 'string') return undefined
      for (const driver of byKind.values()) {
        if (driver.isReference(value)) return driver
      }
      return undefined
    },
  }
}

export function createDefaultProviderRegistry(options = {}) {
  return createProviderRegistry([createOnePasswordDriver(options.onepassword)])
}
