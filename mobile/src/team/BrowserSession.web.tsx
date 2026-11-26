import { useEffect, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { holdBrowserSession } from './browser-session.ts'
import { t } from '../ui/i18n.ts'
import { useTheme } from '../ui/tokens.ts'

export function BrowserSession({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'waiting' | 'ready' | 'failed'>('waiting')
  const { p } = useTheme()
  useEffect(() => {
    if (!navigator.locks) { setState('failed'); return }
    return holdBrowserSession(navigator.locks, () => setState('ready'), () => setState('failed'))
  }, [])
  if (state === 'ready') return children
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main, padding: 24 }}>
    <Text accessibilityRole="alert" style={{ color: p.ink, textAlign: 'center' }}>{state === 'waiting' ? t('DS Bot is open in another tab') : t('This browser cannot keep a single DS Bot tab active. Use a browser with Web Locks over HTTPS or localhost.')}</Text>
  </View>
}
