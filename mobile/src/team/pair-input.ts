import { parsePairingUri } from '../../../link/src/index.ts'

export function parsePairingInput(input: string) {
  try {
    const text = input.trim()
    const url = new URL(text)
    const browserLink = (url.protocol === 'https:' || url.protocol === 'http:') && url.hash.startsWith('#pair=')
    return parsePairingUri(browserLink ? decodeURIComponent(url.hash.slice('#pair='.length)) : text)
  } catch {
    throw new Error('This is not a DS Bot pairing code.')
  }
}
