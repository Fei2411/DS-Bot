export const SHIMMER_MIN_OPACITY = 0.35
export const SHIMMER_MAX_OPACITY = 1
export const SHIMMER_STATIC_OPACITY = 1
export const SHIMMER_PHASE_MS = 900

export interface ShimmerAnimatedValue {
  setValue(value: number): void
  stopAnimation(callback?: (value: number) => void): void
}

export interface ShimmerCompositeAnimation {
  start(callback?: (result: { finished: boolean }) => void): void
  stop(): void
  reset?(): void
}

export interface ShimmerTimingConfig {
  toValue: number
  duration: number
  useNativeDriver: boolean
  isInteraction?: boolean
}

export interface ShimmerLoopConfig {
  iterations: number
  resetBeforeIteration?: boolean
}

export interface ShimmerAnimatedApi<
  TValue extends ShimmerAnimatedValue = ShimmerAnimatedValue,
  TAnim extends ShimmerCompositeAnimation = ShimmerCompositeAnimation,
> {
  loop(animation: TAnim, config?: ShimmerLoopConfig): TAnim
  sequence(animations: TAnim[]): TAnim
  timing(value: TValue, config: ShimmerTimingConfig): TAnim
}

export interface ShimmerLoopOptions<
  TValue extends ShimmerAnimatedValue = ShimmerAnimatedValue,
  TAnim extends ShimmerCompositeAnimation = ShimmerCompositeAnimation,
> {
  reduced: boolean
  active?: boolean
  useNativeDriver?: boolean
  animated: ShimmerAnimatedApi<TValue, TAnim>
}

export function initialShimmerOpacity(reduced: boolean, active = true): number {
  return reduced || !active ? SHIMMER_STATIC_OPACITY : SHIMMER_MIN_OPACITY
}

// Continuous UI-thread Reanimated loops can starve Fabric JS ShadowTree commits
// during streaming; core Animated.loop with useNativeDriver keeps the pulse on
// the native animation driver without blocking React commits.
export function startShimmerLoop<
  TValue extends ShimmerAnimatedValue,
  TAnim extends ShimmerCompositeAnimation,
>(value: TValue, options: ShimmerLoopOptions<NoInfer<TValue>, TAnim>): () => void {
  const active = options.active ?? true
  const useNativeDriver = options.useNativeDriver ?? true
  value.stopAnimation()

  if (options.reduced || !active) {
    value.setValue(SHIMMER_STATIC_OPACITY)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      value.stopAnimation()
    }
  }

  value.setValue(SHIMMER_MIN_OPACITY)
  // Animated.loop defaults resetBeforeIteration to true, which resets Animated.Value
  // back to its constructor _startingValue (1 if first mounted reduced/inactive)
  // before every cycle. The sequence already ends at SHIMMER_MIN_OPACITY, so
  // disabling reset avoids snapping back to 1 and keeps each phase continuous.
  const loop = options.animated.loop(
    options.animated.sequence([
      options.animated.timing(value, {
        toValue: SHIMMER_MAX_OPACITY,
        duration: SHIMMER_PHASE_MS,
        useNativeDriver,
        isInteraction: false,
      }),
      options.animated.timing(value, {
        toValue: SHIMMER_MIN_OPACITY,
        duration: SHIMMER_PHASE_MS,
        useNativeDriver,
        isInteraction: false,
      }),
    ]),
    { iterations: -1, resetBeforeIteration: false },
  )
  loop.start()

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    loop.stop()
    value.stopAnimation()
  }
}
