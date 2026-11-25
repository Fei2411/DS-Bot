// Pure-JS bounded LRU helpers with no React dependency so Node build scripts
// (e.g. app/scripts/start-assets.mjs) can import pure client modules like characters.js
// without ds-bot/node_modules installed.

export function lruGet(map, key) {
  if (!map.has(key)) return undefined
  const value = map.get(key)
  map.delete(key)
  map.set(key, value)
  return value
}

export function lruSet(map, key, value, max) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
}
