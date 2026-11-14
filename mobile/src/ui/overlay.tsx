import { useEffect, useState, type ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { t } from './i18n.ts'
import { SPRING_SHAPE } from './tokens.ts'

// The panel rises on SPRING_SHAPE; a close first plays the .16s exit before the
// modal unmounts, and snaps under reduced motion. The children keep their own
// margins. Height is unknown until the first layout — the panel waits hidden
// until then, so the rise starts from off screen rather than flashing at 0.
export function SheetUp({ open, onClose, label, children }: { open: boolean; onClose: () => void; label?: string; children: ReactNode }) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(open)
  const [panelHeight, setPanelHeight] = useState(0)
  const rise = useSharedValue(0)
  const scrim = useSharedValue(0)
  useEffect(() => { if (open) setShown(true) }, [open])
  useEffect(() => {
    if (!shown) return
    if (open) {
      if (panelHeight === 0) return
      if (reduced) { rise.value = 1; scrim.value = 1; return }
      rise.value = withSpring(1, SPRING_SHAPE)
      scrim.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) })
    } else if (reduced) {
      setShown(false)
    } else {
      const done = (finished?: boolean) => {
        'worklet'
        if (finished === true) runOnJS(setShown)(false)
      }
      rise.value = withTiming(0, { duration: 160, easing: Easing.out(Easing.quad) }, done)
      scrim.value = withTiming(0, { duration: 160 })
    }
  }, [open, shown, panelHeight, reduced])
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - rise.value) * (panelHeight + 24) }] }))
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }))
  if (!shown) return null
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.scrim, scrimStyle]} />
        <Pressable accessibilityRole="button" accessibilityLabel={label ?? t('Close')} onPress={onClose} style={StyleSheet.absoluteFill} />
        <Animated.View onLayout={event => setPanelHeight(event.nativeEvent.layout.height)} style={[styles.panel, panelHeight === 0 ? { opacity: 0 } : null, panelStyle]}>
          {children}
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0 },
})
