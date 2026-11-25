import * as React from 'react'

// Unit tests run with minimal React stubs that omit React.memo and invoke components
// directly as functions; fall back to the unwrapped function in that environment.
export function memo(component, compare, displayName) {
  if (displayName && component.name !== displayName) {
    Object.defineProperty(component, 'name', { value: displayName, configurable: true })
  }
  if (typeof React.memo === 'function') {
    const wrapped = React.memo(component, compare)
    if (displayName) wrapped.displayName = displayName
    return wrapped
  }
  return component
}

// Subscribe to a narrow set of top-level roster fields while still returning the
// roster snapshot shape expected by downstream helpers. Unrelated live updates
// outside `fields` (e.g. imStatus, learning, phone, mcp, plugins) keep the previous
// object reference so React skips re-rendering settled transcript cells (#1812).
export function useRosterPick(useRoster, fields) {
  const prev = React.useRef(null)
  return useRoster((roster) => {
    const last = prev.current
    if (last !== null && roster !== null && roster !== undefined && fields.every(key => last[key] === roster[key])) return last
    prev.current = roster
    return roster
  })
}

export { lruGet, lruSet } from './lru.js'
