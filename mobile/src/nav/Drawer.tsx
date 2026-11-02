import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { SPRING_SHAPE } from '../ui/tokens.ts'

const DrawerCtx = createContext({ open: () => {}, close: () => {} })
export const useDrawer = () => useContext(DrawerCtx)

// The desktop sidebar as a left drawer: edge pan or the header button opens it,
// a pan on the panel or a tap on the scrim closes it, and the hardware back
// button closes it first.
export function Drawer({ width, edgeWidth = 24, edgeEnabled = true, content, children }: { width: number; edgeWidth?: number; edgeEnabled?: boolean; content: ReactNode; children: ReactNode }) {
  const reduced = useReducedMotion()
  const x = useSharedValue(-width)
  const [shown, setShown] = useState(false)

  const snapTo = (to: number) => {
    const opening = to === 0
    if (opening) setShown(true)
    if (reduced) {
      x.value = to
      if (!opening) setShown(false)
    } else {
      x.value = withSpring(to, SPRING_SHAPE, finished => {
        'worklet'
        if (finished && !opening) runOnJS(setShown)(false)
      })
    }
  }
  const open = () => snapTo(0)
  const close = () => snapTo(-width)

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (x.value > -width) { close(); return true }
      return false
    })
    return () => sub.remove()
  })

  const clampX = (v: number) => {
    'worklet'
    return Math.min(0, Math.max(-width, v))
  }
  const edgePan = Gesture.Pan()
    .activeOffsetX(8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = clampX(-width + Math.max(0, e.translationX)) })
    .onEnd(e => { runOnJS(snapTo)(e.velocityX > 350 || x.value > -width / 2 ? 0 : -width) })
  const drawerPan = Gesture.Pan()
    .activeOffsetX(-8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = clampX(e.translationX) })
    .onEnd(e => { runOnJS(snapTo)(e.velocityX < -350 || x.value < -width / 2 ? -width : 0) })

  const scrimStyle = useAnimatedStyle(() => ({ opacity: (x.value + width) / width }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))

  return (
    <DrawerCtx.Provider value={{ open, close }}>
      <View style={{ flex: 1 }}>
        {children}
        {!shown && edgeEnabled ? (
          <GestureDetector gesture={edgePan}>
            <View style={[styles.edge, { width: edgeWidth }]} />
          </GestureDetector>
        ) : null}
        <View pointerEvents={shown ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.scrim, scrimStyle]}>
            <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close team list" />
          </Animated.View>
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.panel, { width }, panelStyle]}>{content}</Animated.View>
          </GestureDetector>
        </View>
      </View>
    </DrawerCtx.Provider>
  )
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0 },
})
