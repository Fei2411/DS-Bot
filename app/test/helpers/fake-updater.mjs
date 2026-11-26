// The updater of the app, as a test double: it records what the app asked of it.
import { EventEmitter } from 'node:events'

export const state = { checks: 0, downloads: 0, quitAndInstall: [], autoDownload: false, autoInstallOnAppQuit: false }

export class FakeUpdater extends EventEmitter {
  get autoDownload() { return state.autoDownload }
  set autoDownload(value) { state.autoDownload = value }
  get autoInstallOnAppQuit() { return state.autoInstallOnAppQuit }
  set autoInstallOnAppQuit(value) { state.autoInstallOnAppQuit = value }
  checkForUpdates() { state.checks += 1; return Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.2.2' } }) }
  downloadUpdate() { state.downloads += 1; return Promise.resolve(['installer.exe']) }
  setFeedURL() {}
  quitAndInstall(...args) { state.quitAndInstall.push(args) }
}

export const updater = new FakeUpdater()

export default { autoUpdater: updater }
