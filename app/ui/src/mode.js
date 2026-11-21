// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the team's
// appearance sets it: light, dark, or the system's mode when it names none.
const dark = matchMedia('(prefers-color-scheme: dark)')
let chosen

const paint = () => {
  document.body.toggleAttribute('data-ds-dark-theme', chosen === 'dark' || (chosen !== 'light' && dark.matches))
}
dark.addEventListener('change', paint)

/** @param {'light' | 'dark' | undefined} mode - undefined follows the system */
export function paintMode(mode) {
  chosen = mode
  paint()
}
