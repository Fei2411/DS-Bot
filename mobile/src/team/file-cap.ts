import { t } from '../ui/i18n.ts'

// A host file read whole travels inside one api/bot answer (mobile.js file-read), so
// hello.maxFileBytes is the biggest file a save can carry (#1443). The phone refuses
// with the limit named the way the host's own refusal names it, before the bytes move.
export const fileOverCap = (maxFileBytes: number | undefined, bytes: number | undefined): boolean =>
  maxFileBytes !== undefined && bytes !== undefined && bytes > maxFileBytes

export const fileCapMessage = (maxFileBytes: number): string =>
  t('This file is too large to save here (over {size} MB)', { size: Math.max(1, Math.round(maxFileBytes / 1048576)) })

// A file the chat hands over as a web link saves from the web, not over the chat's
// own file endpoints.
export const fileRouteOf = (file: { url?: string }): 'url' | 'host' =>
  typeof file.url === 'string' && file.url !== '' ? 'url' : 'host'
