export function zoomKey(input, platform) {
  if (platform === 'darwin' || input?.type !== 'keyDown' || !input.control || input.alt || input.meta || input.isComposing) return null
  if ((input.key === '0' && (!input.shift || input.code === 'Digit0')) || (input.code === 'Digit0' && !input.shift)) return 'reset'
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in'
  if ((input.key === '-' && !input.shift) || input.code === 'NumpadSubtract') return 'out'
  return null
}

// Chromium's page zoom range is 25%–500%; levels use a factor of 1.2.
export function zoomLevel(level, action) {
  if (action === 'reset') return 0
  return Math.max(Math.log(0.25) / Math.log(1.2), Math.min(Math.log(5) / Math.log(1.2), level + (action === 'in' ? 0.5 : -0.5)))
}
