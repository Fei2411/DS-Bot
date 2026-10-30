// The one-time confirmation before the window hides into the tray. The app goes on running
// after the window closes, so the user is told once, and only an explicit answer lets the
// window go; the answer is remembered under the app's own data.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class BackgroundNotice {
  #marker
  #show
  #focus
  #message
  #confirm
  #log
  #acknowledged = false
  #pending = false
  #disposed = false

  /**
   * @param {{
   *   marker: string,
   *   show: (options: object) => Promise<{ response: number }>,
   *   focus?: () => void,
   *   message: string,
   *   confirm: string,
   *   log?: Pick<Console, 'warn'>,
   * }} options `marker` is where the acknowledgement is kept, `show` the shell dialog.
   */
  constructor(options) {
    this.#marker = options.marker
    this.#show = options.show
    this.#focus = options.focus ?? (() => {})
    this.#message = options.message
    this.#confirm = options.confirm
    this.#log = options.log ?? console
  }

  /**
   * Hide the window, asking once until the user has acknowledged it.
   * @param {() => void} hide - hides the window, once the answer allows it
   */
  close(hide) {
    if (this.#disposed) return
    // A second close while the box is open joins it instead of opening another one.
    if (this.#pending) { this.#focus(); return }
    if (this.#acknowledged || existsSync(this.#marker)) {
      this.#acknowledged = true
      hide()
      return
    }
    this.#pending = true
    void this.#ask(hide)
  }

  /** The app is on its way out: a late answer no longer hides anything. */
  dispose() { this.#disposed = true }

  async #ask(hide) {
    try {
      const { response } = await this.#show({
        type: 'info', title: 'DeepSeek Bot', message: this.#message,
        buttons: [this.#confirm], defaultId: 0, cancelId: -1, noLink: true,
      })
      // A cancelled box leaves the window where it is.
      if (this.#disposed || response !== 0) return
      this.#acknowledged = true
      try {
        mkdirSync(dirname(this.#marker), { recursive: true })
        writeFileSync(this.#marker, '')
      } catch (error) {
        this.#log.warn(`DeepSeek Bot: the tray notice was not remembered: ${error instanceof Error ? error.message : String(error)}`)
      }
      hide()
    } catch (error) {
      this.#log.warn(`DeepSeek Bot: the tray notice could not be shown: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.#pending = false
    }
  }
}
