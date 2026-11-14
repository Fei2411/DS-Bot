import { useEffect, useState, type ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { t } from './i18n.ts'
import { SPRING_SHAPE } from './tokens.ts'

// A small bottom sheet, the phone's form of ui-standard 9.4's rising surface:
// the panel springs up (SPRING_SHAPE), the scrim fades in over .22s, and a
// close first slides the panel back down over the .16s exit before the modal
// unmounts. Snaps under reduced motion. The children keep their own margins.
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
      // 0 until the panel has laid out; the rise then starts from off screen.
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
