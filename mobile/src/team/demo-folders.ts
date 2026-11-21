// The demo's stand-ins for the host's `folder-list` and `update-room` answers, in the
// shapes the real host returns (folders.js, roster.js), so demo mode walks the same paths.

const TREE: Record<string, string[]> = {
  '/': ['work'],
  '/work': ['ds-bot', 'docs', 'notes'],
  '/work/ds-bot': ['mobile', 'ds-bot', 'app'],
}

export function demoFolderListing(requested: unknown) {
  // Like the host, an empty path lists the start folder, and the reply names the real one.
  const path = typeof requested === 'string' && requested !== '' ? requested.replace(/\/+$/, '') || '/' : '/'
  const steps = path.split('/').filter(Boolean)
  const crumbs = [{ name: '/', path: '/' }, ...steps.map((name, index) => ({ name, path: `/${steps.slice(0, index + 1).join('/')}` }))]
  const entries = (TREE[path] ?? []).map(name => ({ name, path: path === '/' ? `/${name}` : `${path}/${name}` }))
  return { path, crumbs, entries, truncated: false }
}

// The patch lands on the room; the computer reads `''` as "clear" and the state omits the key.
export function demoUpdateRoom<T extends { workDir?: string }>(room: T, body: Record<string, unknown>): void {
  const { id: _id, ...patch } = body
  Object.assign(room, patch)
  if (patch.workDir === '') delete room.workDir
}
