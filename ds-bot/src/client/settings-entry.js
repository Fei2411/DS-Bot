// Re-exports SettingsDialog for static plugin builds; the desktop Vite build aliases this
// module to a React.lazy wrapper (`app/ui/src/settings-entry-lazy.js`) so Settings stays off
// the startup bundle until opened.
export { SettingsDialog } from './settings.js'
