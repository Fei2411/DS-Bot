import { useState } from 'react'
import { Pressable, type PressableProps } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { SPRING_TAP } from './tokens.ts'

const APressable = Animated.createAnimatedComponent(Pressable)

// The ui-standard 10.1 press, on the phone: the whole control scales toward `to`
// on SPRING_TAP while the finger is down and springs back on release. Only the
// scale is animated, so the caller's style can keep changing colors freely.
// Under reduced motion the scale stays 1.
// A style function is resolved here, against our own pressed state: Pressable
// only recognizes a function as the whole style prop, and it reaches it merged
// with the animated scale inside an array.
export function Press({ to = 0.96, disabled, onPressIn, onPressOut, style, ...rest }: PressableProps & { to?: number }) {
  const reduced = useReducedMotion()
  const [pressed, setPressed] = useState(false)
  const scale = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const resolve = (entry: PressableProps['style']) =>
    typeof entry === 'function' ? (entry as (state: { pressed: boolean }) => PressableProps['style'])({ pressed }) : entry
  const look = style === undefined ? style : Array.isArray(style) ? style.map(resolve) : resolve(style)
  return (
    <APressable
      disabled={disabled}
      onPressIn={event => { setPressed(true); if (disabled !== true && !reduced) scale.value = withSpring(to, SPRING_TAP); onPressIn?.(event) }}
      onPressOut={event => { setPressed(false); if (scale.value !== 1) scale.value = withSpring(1, SPRING_TAP); onPressOut?.(event) }}
      style={[look, animated]}
      {...rest}
    />
  )
}