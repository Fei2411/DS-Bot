import { useEffect, useState, type ReactNode } from 'react'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { SPRING_SHAPE } from './tokens.ts'

// The content keeps its laid-out size while the height springs, so nothing
// inside re-flows; it is clipped and fades — the one fixed-duration change
// opacity is allowed (ui-standard 9.2). Snaps under reduced motion.
// The content stays mounted while closed, so state inside survives a fold and
// the exit has something to play on; that is also why the folded area is
// hidden from screen readers.
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion()
  const height = useSharedValue(0)
  const fade = useSharedValue(0)
  const [measured, setMeasured] = useState(0)
  useEffect(() => {
    const to = open ? measured : 0
    if (reduced || measured === 0) { height.value = to; fade.value = open ? 1 : 0; return }
    height.value = withSpring(to, SPRING_SHAPE)
    fade.value = withTiming(open ? 1 : 0, { duration: 160 })
  }, [open, measured, reduced])
  const box = useAnimatedStyle(() => ({ height: height.value }))
  const veil = useAnimatedStyle(() => ({ opacity: fade.value }))
  return (
    <Animated.View accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} style={[box, { overflow: 'hidden' }]}>
      <Animated.View style={veil} onLayout={event => setMeasured(event.nativeEvent.layout.height)}>{children}</Animated.View>
    </Animated.View>
  )
}
