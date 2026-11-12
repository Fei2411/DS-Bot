import * as ExpoCrypto from 'expo-crypto'

// Noble reads the Web Crypto random source when its modules load, so this
// file must be imported before anything that imports src/link.
const currentCrypto = globalThis.crypto

if (currentCrypto?.getRandomValues === undefined) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...currentCrypto,
      getRandomValues: ExpoCrypto.getRandomValues,
      randomUUID: ExpoCrypto.randomUUID,
    },
    configurable: true,
  })
}
