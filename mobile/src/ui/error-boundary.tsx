import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { t } from './i18n.ts'
import { radius, type as typeScale, useTheme, type Palette } from './tokens.ts'

interface Props {
  children: ReactNode
  inline?: boolean
  fallback?: (error: Error, reset: () => void) => ReactNode
  onReset?: () => void
  p: Palette
}

interface State {
  error: Error | null
}

class Boundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Error UI holds the message cleanly without tearing down the native tree.
  }

  private reset = () => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback(error, this.reset)
    const { p, inline } = this.props
    if (inline) {
      return (
        <View style={[styles.inlineBox, { backgroundColor: p.card, borderColor: p.line2 }]}>
          <Text style={[typeScale.small, { color: p.danger, flex: 1 }]} numberOfLines={2}>
            {t('Something went wrong')}: {error.message || t('Unknown error')}
          </Text>
          <Pressable accessibilityRole="button" onPress={this.reset} style={[styles.retrySmall, { borderColor: p.line2 }]}>
            <Text style={[typeScale.caption, { color: p.accent, fontWeight: '600' }]}>{t('Retry')}</Text>
          </Pressable>
        </View>
      )
    }
    return (
      <View style={[styles.screen, { backgroundColor: p.main }]}>
        <Text style={[typeScale.headerTitle, { color: p.ink }]}>{t('Something went wrong')}</Text>
        <ScrollView style={styles.msgScroll} contentContainerStyle={{ paddingVertical: 8 }}>
          <Text selectable style={[typeScale.small, { color: p.ink2 }]}>
            {error.message || t('Unknown error')}
          </Text>
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={this.reset} style={[styles.btn, { backgroundColor: p.accent }]}>
          <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Retry')}</Text>
        </Pressable>
      </View>
    )
  }
}

export function ErrorBoundary({ children, inline, fallback, onReset }: {
  children: ReactNode
  inline?: boolean
  fallback?: (error: Error, reset: () => void) => ReactNode
  onReset?: () => void
}) {
  const { p } = useTheme()
  return (
    <Boundary p={p} inline={inline} fallback={fallback} onReset={onReset}>
      {children}
    </Boundary>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  msgScroll: { maxHeight: 160, width: '100%' },
  btn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: radius.pill },
  inlineBox: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: radius.card, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
  retrySmall: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
})
