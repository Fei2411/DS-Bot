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

export function parsePhonePairingInput(input: string) {
  const offer = parsePairingInput(input)
  if (offer.device === 'browser') throw new Error('This is a browser pairing link. In Settings → Phone on the computer, scan the QR code to pair the phone app.')
  return offer
}

export function parseWebPairingInput(input: string) {
  const offer = parsePairingInput(input)
  if (offer.device !== 'browser') throw new Error("This is the phone app's code. In Settings → Phone on the computer, use Open in a browser or Copy browser link.")
  return offer
}
