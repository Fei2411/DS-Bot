import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import {
  SHIMMER_MAX_OPACITY,
  SHIMMER_MIN_OPACITY,
  SHIMMER_PHASE_MS,
  SHIMMER_STATIC_OPACITY,
  initialShimmerOpacity,
  startShimmerLoop,
  type ShimmerAnimatedApi,
  type ShimmerAnimatedValue,
  type ShimmerCompositeAnimation,
  type ShimmerLoopConfig,
  type ShimmerTimingConfig,
} from './shimmer.ts'

interface FakeLoopHandle extends ShimmerCompositeAnimation {
  starts: number
  stops: number
  resets: number
  config?: ShimmerLoopConfig
}

function createFakeAnimated() {
  const values: Array<{
    startingValue: number
    current: number
    setCalls: number[]
    stopCalls: number
    resetCalls: number
    nativeDriven: boolean
  }> = []
  const timings: ShimmerTimingConfig[] = []
  const sequences: ShimmerCompositeAnimation[][] = []
  const loops: FakeLoopHandle[] = []

  class FakeValue implements ShimmerAnimatedValue {
    readonly record: (typeof values)[number]
    constructor(initial: number) {
      this.record = {
        startingValue: initial,
        current: initial,
        setCalls: [],
        stopCalls: 0,
        resetCalls: 0,
        nativeDriven: false,
      }
      values.push(this.record)
    }
    setValue(next: number) {
      // Mirrors RN AnimatedValue: setValue updates current value, not _startingValue.
      this.record.current = next
      this.record.setCalls.push(next)
    }
    resetAnimation() {
      // Mirrors RN AnimatedValue.resetAnimation: restores constructor _startingValue.
      this.record.resetCalls += 1
      this.record.current = this.record.startingValue
    }
    stopAnimation(cb?: (value: number) => void) {
      this.record.stopCalls += 1
      cb?.(this.record.current)
    }
  }

  const animated: ShimmerAnimatedApi<FakeValue, FakeLoopHandle> & {
    Value: typeof FakeValue
    Text: string
  } = {
    Value: FakeValue,
    Text: 'Animated.Text',
    timing(value, config) {
      timings.push(config)
      const handle: FakeLoopHandle = {
        starts: 0,
        stops: 0,
        resets: 0,
        start() {
          if (config.useNativeDriver) {
            value.record.nativeDriven = true
          } else if (value.record.nativeDriven) {
            throw new Error('Cannot run JS-driven animation on a value already bound to the native driver')
          }
          handle.starts += 1
        },
        stop() { handle.stops += 1 },
        reset() {
          handle.resets += 1
          value.resetAnimation()
        },
      }
      return handle
    },
    sequence(steps) {
      sequences.push(steps)
      const handle: FakeLoopHandle = {
        starts: 0,
        stops: 0,
        resets: 0,
        start() {
          handle.starts += 1
          for (const step of steps) step.start()
        },
        stop() {
          handle.stops += 1
          for (const step of steps) step.stop()
        },
        reset() {
          handle.resets += 1
          for (const step of steps) step.reset?.()
        },
      }
      return handle
    },
    loop(inner, config) {
      const handle: FakeLoopHandle = {
        starts: 0,
        stops: 0,
        resets: 0,
        config,
        start() {
          handle.starts += 1
          // Mirrors RN Animated.loop: resetBeforeIteration defaults to true and runs before iteration 1.
          if (config?.resetBeforeIteration !== false) inner.reset?.()
          inner.start()
        },
        stop() {
          handle.stops += 1
          inner.stop()
        },
        reset() {
          handle.resets += 1
          inner.reset?.()
        },
      }
      loops.push(handle)
      return handle
    },
  }

  return { animated, values, timings, sequences, loops }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function mountActionRowHarness(initial: { reduced?: boolean; platformOs?: 'ios' | 'android' | 'web' } = {}) {
  const source = readFileSync(new URL('./dock.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('export function ActionRow(')
  const end = source.indexOf('\nconst type =', start)
  assert.ok(start >= 0 && end > start, 'ActionRow declaration must exist in dock.tsx')
  const snippet = source.slice(start, end).replace(/^export /, '')
  const { outputText } = ts.transpileModule(snippet, { compilerOptions: { jsx: ts.JsxEmit.React } })

  const fake = createFakeAnimated()
  let reduced = initial.reduced ?? false
  const platformOs = initial.platformOs ?? 'ios'
  const refs: Array<{ current: unknown }> = []
  let refCursor = 0
  let prevDeps: unknown[] | undefined
  let cleanup: (() => void) | undefined

  const ActionRow = runInNewContext(`${outputText}\nActionRow`, {
    React: { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }) },
    Animated: fake.animated,
    Platform: { get OS() { return platformOs } },
    View: 'View',
    Avatar: 'Avatar',
    styles: { action: {} },
    type: { rowPreview: {} },
    useReducedMotion: () => reduced,
    initialShimmerOpacity,
    startShimmerLoop,
    useRef: (init: unknown) => {
      const idx = refCursor++
      if (!(idx in refs)) refs[idx] = { current: init }
      return refs[idx]
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const changed = prevDeps === undefined || deps === undefined || deps.some((d, i) => !Object.is(d, prevDeps![i]))
      if (!changed) return
      cleanup?.()
      prevDeps = deps
      const next = fn()
      cleanup = typeof next === 'function' ? next : undefined
    },
  })

  return {
    fake,
    setReduced(next: boolean) { reduced = next },
    render(props: { doing: string; active?: boolean }) {
      refCursor = 0
      return ActionRow({ bot: { id: 'b1', name: 'Bot' }, p: { main: '#fff', ink2: '#666' }, dark: false, ...props })
    },
    unmount() {
      cleanup?.()
      cleanup = undefined
    },
  }
}

test('initialShimmerOpacity uses readable static opacity under reduced motion or inactive state', () => {
  assert.equal(initialShimmerOpacity(false, true), SHIMMER_MIN_OPACITY)
  assert.equal(initialShimmerOpacity(true, true), SHIMMER_STATIC_OPACITY)
  assert.equal(initialShimmerOpacity(false, false), SHIMMER_STATIC_OPACITY)
  assert.equal(initialShimmerOpacity(true, false), SHIMMER_STATIC_OPACITY)
})

test('startShimmerLoop drives a native Animated.loop without resetBeforeIteration and stops cleanly', () => {
  const fake = createFakeAnimated()
  const value = new fake.animated.Value(SHIMMER_MIN_OPACITY)

  const stop = startShimmerLoop(value, { reduced: false, active: true, useNativeDriver: true, animated: fake.animated })

  assert.equal(value.record.current, SHIMMER_MIN_OPACITY)
  assert.equal(value.record.resetCalls, 0)
  assert.equal(fake.sequences.length, 1)
  assert.equal(fake.sequences[0].length, 2)
  assert.deepEqual(fake.timings, [
    { toValue: SHIMMER_MAX_OPACITY, duration: SHIMMER_PHASE_MS, useNativeDriver: true, isInteraction: false },
    { toValue: SHIMMER_MIN_OPACITY, duration: SHIMMER_PHASE_MS, useNativeDriver: true, isInteraction: false },
  ])
  assert.equal(fake.loops.length, 1)
  assert.deepEqual(fake.loops[0].config, { iterations: -1, resetBeforeIteration: false })
  assert.equal(fake.loops[0].starts, 1)
  assert.equal(fake.loops[0].stops, 0)

  stop()
  assert.equal(fake.loops[0].stops, 1)
  assert.equal(value.record.stopCalls, 2)

  // Calling cleanup twice is idempotent.
  stop()
  assert.equal(fake.loops[0].stops, 1)
  assert.equal(value.record.stopCalls, 2)
})

test('startShimmerLoop preserves SHIMMER_MIN_OPACITY start when value was initialized at static opacity', () => {
  const fake = createFakeAnimated()
  const value = new fake.animated.Value(SHIMMER_STATIC_OPACITY)

  const stop = startShimmerLoop(value, { reduced: false, active: true, useNativeDriver: true, animated: fake.animated })

  // Because resetBeforeIteration is false, loop.start() must not reset opacity back to _startingValue (1).
  assert.equal(value.record.startingValue, SHIMMER_STATIC_OPACITY)
  assert.equal(value.record.resetCalls, 0)
  assert.equal(value.record.current, SHIMMER_MIN_OPACITY)
  assert.deepEqual(fake.loops[0].config, { iterations: -1, resetBeforeIteration: false })
  stop()
})

test('startShimmerLoop skips looping under reduced motion or inactive state and holds full opacity', () => {
  for (const options of [
    { reduced: true, active: true },
    { reduced: false, active: false },
    { reduced: true, active: false },
  ]) {
    const fake = createFakeAnimated()
    const value = new fake.animated.Value(SHIMMER_MIN_OPACITY)

    const stop = startShimmerLoop(value, { ...options, useNativeDriver: true, animated: fake.animated })

    assert.equal(fake.loops.length, 0)
    assert.equal(fake.sequences.length, 0)
    assert.equal(fake.timings.length, 0)
    assert.equal(value.record.current, SHIMMER_STATIC_OPACITY)
    assert.equal(value.record.stopCalls, 1)

    stop()
    assert.equal(value.record.stopCalls, 2)
    stop()
    assert.equal(value.record.stopCalls, 2)
  }
})

test('ActionRow mounts RN Animated.loop on native, respects reduced/active toggles, and cleans up on unmount', () => {
  const nativeRow = mountActionRowHarness({ reduced: false, platformOs: 'ios' })

  // Initial native mount starts one native-driver loop.
  const firstTree = nativeRow.render({ doing: 'Thinking' })
  assert.equal(nativeRow.fake.values.length, 1)
  assert.equal(nativeRow.fake.loops.length, 1)
  assert.equal(nativeRow.fake.loops[0].starts, 1)
  assert.equal(nativeRow.fake.timings[0].useNativeDriver, true)
  assert.equal(firstTree.children[1].type, 'Animated.Text')

  // Updating doing text reuses the same Animated.Value without restarting the loop.
  nativeRow.render({ doing: 'Reading files' })
  assert.equal(nativeRow.fake.values.length, 1)
  assert.equal(nativeRow.fake.loops.length, 1)

  // Enabling reduced motion stops the active loop and holds opacity at 1.
  nativeRow.setReduced(true)
  nativeRow.render({ doing: 'Reading files' })
  assert.equal(nativeRow.fake.loops[0].stops, 1)
  assert.equal(nativeRow.fake.loops.length, 1)
  assert.equal(nativeRow.fake.values[0].current, SHIMMER_STATIC_OPACITY)

  // Disabling reduced motion starts a new native loop on the same value.
  nativeRow.setReduced(false)
  nativeRow.render({ doing: 'Writing code' })
  assert.equal(nativeRow.fake.loops.length, 2)
  assert.equal(nativeRow.fake.loops[1].starts, 1)
  assert.equal(nativeRow.fake.timings.at(-1)?.useNativeDriver, true)

  // Pausing via active=false stops the loop without unmounting.
  nativeRow.render({ doing: 'Writing code', active: false })
  assert.equal(nativeRow.fake.loops[1].stops, 1)
  assert.equal(nativeRow.fake.values[0].current, SHIMMER_STATIC_OPACITY)

  // Resuming and unmounting cleans up cleanly.
  nativeRow.render({ doing: 'Finishing', active: true })
  assert.equal(nativeRow.fake.loops.length, 3)
  nativeRow.unmount()
  assert.equal(nativeRow.fake.loops[2].stops, 1)
})

test('ActionRow mounted inactive or reduced starts shimmer at SHIMMER_MIN_OPACITY when later activated', () => {
  for (const scenario of [
    { initialReduced: false, initialActive: false },
    { initialReduced: true, initialActive: true },
  ]) {
    const row = mountActionRowHarness({ reduced: scenario.initialReduced, platformOs: 'android' })
    row.render({ doing: 'Waiting', active: scenario.initialActive })
    assert.equal(row.fake.values[0].startingValue, SHIMMER_STATIC_OPACITY)
    assert.equal(row.fake.values[0].current, SHIMMER_STATIC_OPACITY)
    assert.equal(row.fake.loops.length, 0)

    row.setReduced(false)
    row.render({ doing: 'Working', active: true })
    assert.equal(row.fake.loops.length, 1)
    assert.deepEqual(row.fake.loops[0].config, { iterations: -1, resetBeforeIteration: false })
    assert.equal(row.fake.values[0].resetCalls, 0)
    assert.equal(row.fake.values[0].current, SHIMMER_MIN_OPACITY)
    row.unmount()
  }
})

test('ActionRow on web disables useNativeDriver on an independent Animated.Value instance', () => {
  const webRow = mountActionRowHarness({ reduced: false, platformOs: 'web' })
  webRow.render({ doing: 'Thinking' })
  assert.equal(webRow.fake.loops.length, 1)
  assert.equal(webRow.fake.timings[0].useNativeDriver, false)
  assert.equal(webRow.fake.values[0].nativeDriven, false)
  webRow.unmount()
  assert.equal(webRow.fake.loops[0].stops, 1)
})

test('mobile/src contains zero Reanimated withRepeat looping animations', () => {
  const mobileSrc = fileURLToPath(new URL('../..', import.meta.url))
  const files = walkTsFiles(mobileSrc)
  assert.ok(files.length > 0, 'expected TypeScript sources under mobile/src')
  const offenders: string[] = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, kind)
    let found = false
    const visit = (node: ts.Node) => {
      if (found) return
      if (ts.isIdentifier(node) && node.text === 'withRepeat') {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    if (found) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'infinite Reanimated withRepeat loops must use RN Animated.loop instead')
})
