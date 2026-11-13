import { Pressable, type PressableProps } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { SPRING_TAP } from './tokens.ts'

const APressable = Animated.createAnimatedComponent(Pressable)

// The ui-standard 10.1 press, on the phone: the whole control scales toward `to`
// on SPRING_TAP while the finger is down and springs back on release. Only the
// scale is animated, so the caller's style can keep changing colors freely.
// Under reduced motion the scale stays 1.
export function Press({ to = 0.96, disabled, onPressIn, onPressOut, style, ...rest }: PressableProps & { to?: number }) {
  const reduced = useReducedMotion()
  const scale = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  return (
    <APressable
      disabled={disabled}
      onPressIn={event => { if (disabled !== true && !reduced) scale.value = withSpring(to, SPRING_TAP); onPressIn?.(event) }}
      onPressOut={event => { if (scale.value !== 1) scale.value = withSpring(1, SPRING_TAP); onPressOut?.(event) }}
      style={[style, animated]}
      {...rest}
    />
  )
}
