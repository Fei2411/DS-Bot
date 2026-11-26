import { Children, Fragment } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useInSheet } from '../nav/sheet.tsx'
import { t } from '../ui/i18n.ts'
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

export function SettingsScreen({ children }: { children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const inSheet = useInSheet()
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: inSheet ? 0 : insets.top }}>{children}</View>
}

export function SettingsBack({ title, onBack }: { title: string; onBack: () => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.backRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} hitSlop={8} style={styles.backBtn}>
        <ChevronLeftIcon size={20} color={p.ink2} />
      </Pressable>
      <Text style={[typeScale.rowName, { color: p.ink, flex: 1, textAlign: 'center' }]}>{title}</Text>
      <View style={styles.backBtn} />
    </View>
  )
}

export function SettingsSection({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  const items = Children.toArray(children).filter(Boolean)
  if (items.length === 0) return null
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 ? <View style={[styles.divider, { backgroundColor: p.line }]} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
    </View>
  )
}

export function SettingsRow({ label, value, valueColor, onPress, end }: { label: string; value?: string; valueColor?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, minWidth: 96 }]}>{label}</Text>
      {value !== undefined ? (
        <Text style={[typeScale.settingsRow, { color: valueColor ?? p.ink2, flexShrink: 1, maxWidth: '52%', textAlign: 'right' }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {end}
      {onPress ? <View style={{ flexShrink: 0 }}><ChevronRightIcon size={16} color={p.ink3} /></View> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

export function SettingsChoice<T extends string>({ label, options, value, onPick }: { label: string; options: { id: T; label: string }[]; value: T; onPick: (id: T) => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.choice}>
      <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
      <View style={[styles.segments, { backgroundColor: p.hover }]} accessibilityRole="radiogroup">
        {options.map(option => {
          const on = option.id === value
          return (
            <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onPick(option.id)}
              style={[styles.segment, on && [{ backgroundColor: p.card }, shadow(1)]]}>
              <Text style={[typeScale.small, { color: on ? p.ink : p.ink2, fontWeight: on ? '600' : '400', textAlign: 'center' }]} numberOfLines={1}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', ...shadow(1) },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, minHeight: 50, gap: 10 },
  choice: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  segments: { flexDirection: 'row', borderRadius: radius.row, padding: 2 },
  segment: { flex: 1, minHeight: 34, paddingVertical: 5, borderRadius: radius.input, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
})
