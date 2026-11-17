import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BackHandler, I18nManager, Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { ErrorBoundary } from '../ui/error-boundary.tsx'
import { SPRING_SHAPE } from '../ui/tokens.ts'
import { t } from '../ui/i18n.ts'
import { clampedDrag, panelOffset, snapOnFlick } from './drawer-geometry.ts'

const DrawerCtx = createContext({ open: () => {}, close: () => {}, closeNow: () => {} })
export const useDrawer = () => useContext(DrawerCtx)

// The desktop sidebar as a drawer on the leading side (left in LTR, mirrored
// to the right under RTL): edge pan or the header button opens it, a pan on
// the panel or a tap on the scrim closes it, and the hardware back button
// closes it first.
export function Drawer({ width, edgeWidth = 24, edgeEnabled = true, content, children }: { width: number; edgeWidth?: number; edgeEnabled?: boolean; content: ReactNode; children: ReactNode }) {
  const reduced = useReducedMotion()
  const rtl = I18nManager.isRTL
  const x = useSharedValue(panelOffset(0, width, rtl))
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!shown) x.value = panelOffset(0, width, rtl)
  }, [width, shown, rtl, x])

  const snapTo = useCallback((to: number) => {
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
  }, [reduced, x])

  const open = useCallback(() => snapTo(0), [snapTo])
  const close = useCallback(() => snapTo(panelOffset(0, width, rtl)), [snapTo, width, rtl])
  // Navigation from the drawer must not race the close spring: land the panel
  // at the closed offset and drop the interactive layer in the same tick.
  const closeNow = useCallback(() => {
    x.value = panelOffset(0, width, rtl)
    setShown(false)
  }, [rtl, width, x])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // The open state decides, not the mid-flight offset: the event is only
      // claimed while the drawer is actually open, on either side.
      if (shown) { close(); return true }
      return false
    })
    return () => sub.remove()
  }, [close, shown])

  // RTL mirrors the finger directions the gestures listen for.
  const edgePan = useMemo(() => Gesture.Pan()
    .enabled(!shown && edgeEnabled)
    .activeOffsetX(rtl ? -8 : 8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = clampedDrag(e.translationX, width, 0, rtl) })
    .onEnd(e => { runOnJS(snapTo)(snapOnFlick(e.velocityX, x.value, width, rtl, 0)) }),
  [shown, edgeEnabled, width, rtl, snapTo, x])

  const drawerPan = useMemo(() => Gesture.Pan()
    .enabled(shown)
    .activeOffsetX(rtl ? 8 : -8)
    .failOffsetY([-12, 12])
    .onUpdate(e => { x.value = clampedDrag(e.translationX, width, 1, rtl) })
    .onEnd(e => { runOnJS(snapTo)(snapOnFlick(e.velocityX, x.value, width, rtl, 1)) }),
  [shown, width, rtl, snapTo, x])

  // One formula serves both frames: the panel sits |x| away from open.
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.abs(x.value) / width }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const ctxValue = useMemo(() => ({ open, close, closeNow }), [open, close, closeNow])
  // RTL anchors the panel and the open-edge sensor to the right edge; the edge
  // view stays full-height so it reaches under the header on both sides.
  const side = rtl ? { right: 0 } : { left: 0 }

  return (
    <DrawerCtx.Provider value={ctxValue}>
      <View style={{ flex: 1 }}>
        {children}
        {/* Keep the edge GestureDetector permanently mounted so opening the drawer by tap never detaches an active native Fabric view mid-frame. */}
        <GestureDetector gesture={edgePan}>
          <View pointerEvents={!shown && edgeEnabled ? 'auto' : 'none'} style={[styles.edge, side, { width: edgeWidth }]} />
        </GestureDetector>
        <View pointerEvents={shown ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.scrim, scrimStyle]}>
            <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel={t('Close team list')} />
          </Animated.View>
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.panel, side, { width }, panelStyle]}>
              <ErrorBoundary>{content}</ErrorBoundary>
            </Animated.View>
          </GestureDetector>
        </View>
      </View>
    </DrawerCtx.Provider>
  )
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', top: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', top: 0, bottom: 0 },
})
