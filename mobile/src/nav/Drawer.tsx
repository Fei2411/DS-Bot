import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { ErrorBoundary } from '../ui/error-boundary.tsx'
import { SPRING_SHAPE } from '../ui/tokens.ts'
import { t } from '../ui/i18n.ts'
import { handleDrawerBack } from './drawer-back.ts'

const DrawerCtx = createContext({ open: () => {}, close: () => {} })
export const useDrawer = () => useContext(DrawerCtx)

// The desktop sidebar as a left drawer: edge pan or the header button opens it,
// a pan on the panel or a tap on the scrim closes it, and on Chat a single
// hardware back press opens it while a second press lets the system leave.
export function Drawer({ width, edgeWidth = 24, edgeEnabled = true, backOpens = true, content, children }: { width: number; edgeWidth?: number; edgeEnabled?: boolean; backOpens?: boolean | (() => boolean); content: ReactNode; children: ReactNode }) {
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
    .activeOffsetX(8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = Math.min(0, Math.max(-width, -width + Math.max(0, e.translationX))) })
    .onEnd(e => { runOnJS(snapTo)(e.velocityX > 350 || x.value > -width / 2 ? 0 : -width) }),
  [shown, edgeEnabled, width, snapTo, x])

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
        {children}
        {/* Keep the edge GestureDetector permanently mounted so opening the drawer by tap never detaches an active native Fabric view mid-frame. */}
        <GestureDetector gesture={edgePan}>
          <View pointerEvents={!shown && edgeEnabled ? 'auto' : 'none'} style={[styles.edge, { width: edgeWidth }]} />
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
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0 },
})
