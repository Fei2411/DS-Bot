import { t } from '../ui/i18n.ts'

export function teamListEmptyMessage(loaded: boolean, needle: string, matchCount: number): string | null {
  if (!loaded) return t('Connecting…')
  return needle !== '' && matchCount === 0 ? t('No results') : null
}
