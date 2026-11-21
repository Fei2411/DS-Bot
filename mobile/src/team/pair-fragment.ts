export function takePairingFragment(location: { hash: string; pathname: string; search: string }, history: { replaceState(data: unknown, unused: string, url: string): void; state: unknown }): string | undefined {
  if (!location.hash.startsWith('#pair=')) return undefined
  const encoded = location.hash.slice('#pair='.length)
  history.replaceState(history.state, '', location.pathname + location.search)
  try { return decodeURIComponent(encoded) } catch { return '' }
}
