// Eagerly registers all bundled locales for single-file consumers (DSH plugin client.js)
// and synchronous test suites. Desktop app builds skip this file and load locales on demand.
import { registerLocalePack } from '../i18n.js'
import { HOST_ERRORS, ZH } from './zh.js'
import { convertDict, convertHostErrors, toTraditional } from './zh-tw.js'
import { DSH_JA, HOST_ERRORS_JA, JA } from './ja.js'
import { DSH_KO, HOST_ERRORS_KO, KO } from './ko.js'
import { DSH_ES, HOST_ERRORS_ES, ES } from './es.js'
import { DSH_FR, HOST_ERRORS_FR, FR } from './fr.js'
import { DSH_DE, HOST_ERRORS_DE, DE } from './de.js'

registerLocalePack('zh', { dict: ZH, hostErrors: HOST_ERRORS })
registerLocalePack('zh-TW', {
  dict: convertDict(ZH),
  hostErrors: convertHostErrors(HOST_ERRORS),
  convertDict,
  toTraditional,
})
registerLocalePack('ja', { dict: JA, hostErrors: HOST_ERRORS_JA, dsh: DSH_JA })
registerLocalePack('ko', { dict: KO, hostErrors: HOST_ERRORS_KO, dsh: DSH_KO })
registerLocalePack('es', { dict: ES, hostErrors: HOST_ERRORS_ES, dsh: DSH_ES })
registerLocalePack('fr', { dict: FR, hostErrors: HOST_ERRORS_FR, dsh: DSH_FR })
registerLocalePack('de', { dict: DE, hostErrors: HOST_ERRORS_DE, dsh: DSH_DE })
