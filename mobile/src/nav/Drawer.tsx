import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BackHandler, I18nManager, Pressable, StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { SPRING_SHAPE } from '../ui/tokens.ts'
import { t } from '../ui/i18n.ts'
import { edgeTop, panelOffset, progressAfterDrag, settleProgress, shouldConsumeBack } from './drawer-geometry.ts'

interface DrawerActions {
  open: () => void
  /** Animate the panel out; touches reach the app underneath at once. */
  close: () => void
  /** Put the panel away in this frame, for a sheet that takes over the screen. */
  closeNow: () => void
}

const DrawerCtx = createContext<DrawerActions>({ open: () => {}, close: () => {}, closeNow: () => {} })
export const useDrawer = () => useContext(DrawerCtx)

// The desktop sidebar as a left drawer: edge pan or the header button opens it,
// a pan on the panel or a tap on the scrim closes it, and the hardware back
// button closes it first.
//
// The position is kept as progress (0 closed, 1 open), not as a pixel offset:
// the offset is computed from the width on every frame, so rotating the tablet
// or resizing a split-screen window can never leave part of the panel on screen
// with the app dimmed behind it, as a captured offset did.
export function Drawer({ width, edgeWidth = 24, edgeEnabled = true, content, children }: { width: number; edgeWidth?: number; edgeEnabled?: boolean; content: ReactNode; children: ReactNode }) {
  const reduced = useReducedMotion()
  const insets = useSafeAreaInsets()
  // `left: 0` lands on the leading edge: the right one on an Arabic tablet.
  const rtl = I18nManager.isRTL
  const progress = useSharedValue(0)
  const startProgress = useSharedValue(0)
  // `shown` owns hit testing, not the animation: it turns false as soon as the
  // drawer starts closing, so a sheet opening underneath is usable right away.
  const [shown, setShown] = useState(false)

  const settle = useCallback((open: boolean, immediate = false) => {
    setShown(open)
    const target = open ? 1 : 0
    progress.value = immediate || reduced ? target : withSpring(target, SPRING_SHAPE)
  }, [progress, reduced])
  const open = useCallback(() => settle(true), [settle])
  const close = useCallback(() => settle(false), [settle])
  const closeNow = useCallback(() => settle(false, true), [settle])
  const actions = useMemo(() => ({ open, close, closeNow }), [open, close, closeNow])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (shouldConsumeBack(progress.value)) { close(); return true }
      return false
    })
    return () => sub.remove()
  }, [close, progress])

  // The pan threshold is generous so a thumb that drifts while tapping a row or
  // the footer button does not turn the tap into a drag.
  const edgePan = useMemo(() => Gesture.Pan()
    .enabled(!shown && edgeEnabled)
    .activeOffsetX(rtl ? -20 : 20)
    .failOffsetY([-12, 12])
    .onBegin(() => { startProgress.value = progress.value })
    .onUpdate(e => { progress.value = progressAfterDrag(startProgress.value, e.translationX, width, rtl) })
    .onEnd(e => { runOnJS(settle)(settleProgress(progress.value, e.velocityX, rtl) === 1) }),
  [shown, edgeEnabled, rtl, width, progress, startProgress, settle])
  const drawerPan = useMemo(() => Gesture.Pan()
    .enabled(shown)
    .activeOffsetX(rtl ? 20 : -20)
    .failOffsetY([-12, 12])
    .onBegin(() => { startProgress.value = progress.value })
    .onUpdate(e => { progress.value = progressAfterDrag(startProgress.value, e.translationX, width, rtl) })
    .onEnd(e => { runOnJS(settle)(settleProgress(progress.value, e.velocityX, rtl) === 1) }),
  [shown, rtl, width, progress, startProgress, settle])

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: panelOffset(progress.value, width, rtl) }] }))

  return (
    <DrawerCtx.Provider value={actions}>
      <View style={{ flex: 1 }}>
        {children}
        {/* Starts below the chat header, so the whole menu button stays tappable. */}
        <GestureDetector gesture={edgePan}>
          <View pointerEvents={!shown && edgeEnabled ? 'auto' : 'none'} style={[styles.edge, { width: edgeWidth, top: edgeTop(insets.top) }]} />
        </GestureDetector>
        <View pointerEvents={shown ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.scrim, scrimStyle]}>
            <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel={t('Close team list')} />
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
  edge: { position: 'absolute', left: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0 },
})
