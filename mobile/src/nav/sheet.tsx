import { createContext, useContext } from 'react'
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '../ui/i18n.ts'
import { type as typeScale, useTheme } from '../ui/tokens.ts'

// A page that slides up over the chat (Settings, Needs you, Create new Bot, Create
// group chat). Its own safe-area provider measures the sheet: on iOS a page sheet
// starts below the status bar, on Android it covers the screen.
// Pages inside a sheet take its top edge as given instead of adding the status bar again.
const InSheet = createContext(false)
export const useInSheet = () => useContext(InSheet)
export function Sheet({ children }: { children: React.ReactNode }) {
  return <SafeAreaProvider><InSheet.Provider value={true}><SheetBody>{children}</SheetBody></InSheet.Provider></SafeAreaProvider>
}
function SheetBody({ children }: { children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: Platform.OS === 'ios' ? 0 : insets.top }}>{children}</View>
}

interface HeaderAction { label: string; onPress: () => void; disabled?: boolean; strong?: boolean }

// The sheet's bar: what it is in the middle, the way out on one side and, for a
// form, the action that finishes it on the other.
export function SheetHeader({ title, left, right }: { title: string; left?: HeaderAction; right?: HeaderAction }) {
  const { p } = useTheme()
  const action = (entry: HeaderAction | undefined, align: 'flex-start' | 'flex-end') => (
    <View style={[styles.side, { alignItems: align }]}>
      {entry !== undefined ? (
        <Pressable accessibilityRole="button" disabled={entry.disabled} onPress={entry.onPress} hitSlop={10} style={styles.action}>
          <Text style={[typeScale.settingsRow, { color: entry.disabled ? p.ink3 : entry.strong ? p.accent : p.ink2, fontWeight: entry.strong ? '600' : '400' }]}>{entry.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
  return (
    <View style={[styles.bar, { borderBottomColor: p.line }]}>
      {Platform.OS === 'ios' ? <View style={[styles.grab, { backgroundColor: p.line2 }]} /> : null}
      <View style={styles.row}>
        {action(left, 'flex-start')}
        <Text style={[typeScale.headerTitle, { color: p.ink, flex: 1, textAlign: 'center' }]} numberOfLines={1}>{title}</Text>
        {action(right, 'flex-end')}
      </View>
    </View>
  )
}

// A destructive step asks once, in the system's own dialog.
export function confirmDanger(title: string, action: string, onConfirm: () => void, message?: string) {
  Alert.alert(title, message, [
    { text: t('Cancel'), style: 'cancel' },
    { text: action, style: 'destructive', onPress: onConfirm },
  ])
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  grab: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, gap: 8 },
  side: { minWidth: 72, maxWidth: '34%', flexShrink: 0 },
  action: { minHeight: 44, justifyContent: 'center' },
})
