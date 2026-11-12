import { Component, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { t } from './i18n.ts'
import { type as typeScale, type Palette } from './tokens.ts'

// Catches a render error in the chat below it so one bad message shows a
// retry instead of closing the whole app. The app has no top-level boundary,
// so an uncaught render throw (for example a message whose data the renderer
// did not expect) force-closes it.
export class ChatErrorBoundary extends Component<{ children: ReactNode; p: Palette; onRetry?: () => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { p } = this.props
    return (
      <View style={{ alignItems: 'center', marginTop: 24 }}>
        <Text style={[typeScale.caption, { color: p.ink3, textAlign: 'center' }]}>{t('Something went wrong showing this chat')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => { this.setState({ failed: false }); this.props.onRetry?.() }}
          style={{ marginTop: 8 }}>
          <Text style={[typeScale.caption, { color: p.accent }]}>{t('Retry')}</Text>
        </Pressable>
      </View>
    )
  }
}
