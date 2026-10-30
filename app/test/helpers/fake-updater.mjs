// The updater of the app, as a test double: it records what the app asked of it.
import { EventEmitter } from 'node:events'

export const state = { checks: 0, quitAndInstall: [], autoDownload: false, autoInstallOnAppQuit: false }

export class FakeUpdater extends EventEmitter {
  checkForUpdates() { state.checks += 1; return Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.2.2' } }) }
  setFeedURL() {}
  quitAndInstall(...args) { state.quitAndInstall.push(args) }
}

export const updater = new FakeUpdater()

export default { autoUpdater: updater }
