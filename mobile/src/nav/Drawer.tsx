import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { ErrorBoundary } from '../ui/error-boundary.tsx'
import { SPRING_SHAPE } from '../ui/tokens.ts'
import { t } from '../ui/i18n.ts'
import { handleDrawerBack } from './drawer-back.ts'

const DrawerCtx = createContext({ open: () => {}, close: () => {} })
export const useDrawer = () => useContext(DrawerCtx)

// The desktop sidebar as a left drawer: a right swipe or the header button opens it,
// a pan on the panel or a tap on the scrim closes it, and on Chat a single
// hardware back press opens it while a second press lets the system leave.
export function Drawer({ width, edgeEnabled = true, backOpens = true, content, children }: { width: number; edgeEnabled?: boolean; backOpens?: boolean | (() => boolean); content: ReactNode; children: ReactNode }) {
  const { width: screenWidth } = useWindowDimensions()
  const reduced = useReducedMotion()
  const x = useSharedValue(-width)
  const [shown, setShown] = useState(false)
  const isOpenRef = useRef(false)
  const backOpensRef = useRef(backOpens)
  backOpensRef.current = backOpens

  useEffect(() => {
    if (!shown) x.value = -width
  }, [width, shown, x])

  const snapTo = useCallback((to: number) => {
    const opening = to === 0
    isOpenRef.current = opening
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
  }, [reduced, x])

  const open = useCallback(() => snapTo(0), [snapTo])
  const close = useCallback(() => snapTo(-width), [snapTo, width])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const canOpen = typeof backOpensRef.current === 'function' ? backOpensRef.current() : backOpensRef.current
      return handleDrawerBack({ isOpen: isOpenRef.current, backOpens: canOpen, open })
    })
    return () => sub.remove()
  }, [open])

  const edgePan = useMemo(() => Gesture.Pan()
    .enabled(!shown && edgeEnabled)
    .activeOffsetX(24)
    .failOffsetX(-8)
    .failOffsetY([-12, 12])
    .onTouchesDown((e, manager) => {
      // Leave the system back edge alone; never claim starts in the right half.
      const start = e.allTouches[0]
      if (e.numberOfTouches !== 1 || !start || start.absoluteX < 20 || start.absoluteX > screenWidth / 2) manager.fail()
    })
    .onEnd(e => { if (e.translationX >= 60 || e.velocityX > 350) runOnJS(open)() }),
  [shown, edgeEnabled, screenWidth, open])

  const drawerPan = useMemo(() => Gesture.Pan()
    .enabled(shown)
    .activeOffsetX(-8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = Math.min(0, Math.max(-width, e.translationX)) })
    .onEnd(e => { runOnJS(snapTo)(e.velocityX < -350 || x.value < -width / 2 ? -width : 0) }),
  [shown, width, snapTo, x])

  const scrimStyle = useAnimatedStyle(() => ({ opacity: (x.value + width) / width }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const ctxValue = useMemo(() => ({ open, close }), [open, close])

  return (
    <DrawerCtx.Provider value={ctxValue}>
      <View style={{ flex: 1 }}>
        <GestureDetector gesture={edgePan}>
          <View style={{ flex: 1 }} collapsable={false}>{children}</View>
        </GestureDetector>
        <View pointerEvents={shown ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.scrim, scrimStyle]}>
            <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel={t('Close team list')} />
          </Animated.View>
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.panel, { width }, panelStyle]}>
              <ErrorBoundary>{content}</ErrorBoundary>
            </Animated.View>
          </GestureDetector>
        </View>
      </View>
    </DrawerCtx.Provider>
  )
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0 },
})
