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
  type ShimmerTimingConfig,
} from './shimmer.ts'

interface FakeLoopHandle extends ShimmerCompositeAnimation {
  starts: number
  stops: number
}

function createFakeAnimated() {
  const values: Array<{
    initial: number
    current: number
    setCalls: number[]
    stopCalls: number
  }> = []
  const timings: ShimmerTimingConfig[] = []
  const sequences: ShimmerCompositeAnimation[][] = []
  const loops: FakeLoopHandle[] = []

  class FakeValue implements ShimmerAnimatedValue {
    readonly record: (typeof values)[number]
    constructor(initial: number) {
      this.record = { initial, current: initial, setCalls: [], stopCalls: 0 }
      values.push(this.record)
    }
    setValue(next: number) {
      this.record.current = next
      this.record.setCalls.push(next)
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
    timing(_value, config) {
      timings.push(config)
      return { starts: 0, stops: 0, start() { this.starts += 1 }, stop() { this.stops += 1 } }
    },
    sequence(steps) {
      sequences.push(steps)
      return { starts: 0, stops: 0, start() { this.starts += 1 }, stop() { this.stops += 1 } }
    },
    loop(_inner) {
      const handle: FakeLoopHandle = {
        starts: 0,
        stops: 0,
        start() { handle.starts += 1 },
        stop() { handle.stops += 1 },
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
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

test('initialShimmerOpacity uses readable static opacity under reduced motion or inactive state', () => {
  assert.equal(initialShimmerOpacity(false, true), SHIMMER_MIN_OPACITY)
  assert.equal(initialShimmerOpacity(true, true), SHIMMER_STATIC_OPACITY)
  assert.equal(initialShimmerOpacity(false, false), SHIMMER_STATIC_OPACITY)
  assert.equal(initialShimmerOpacity(true, false), SHIMMER_STATIC_OPACITY)
})

test('startShimmerLoop drives a native Animated.loop sequence and stops cleanly on cleanup', () => {
  const fake = createFakeAnimated()
  const value = new fake.animated.Value(SHIMMER_MIN_OPACITY)

  const stop = startShimmerLoop(value, { reduced: false, active: true, useNativeDriver: true, animated: fake.animated })

  assert.equal(value.record.current, SHIMMER_MIN_OPACITY)
  assert.equal(fake.sequences.length, 1)
  assert.equal(fake.sequences[0].length, 2)
  assert.deepEqual(fake.timings, [
    { toValue: SHIMMER_MAX_OPACITY, duration: SHIMMER_PHASE_MS, useNativeDriver: true, isInteraction: false },
    { toValue: SHIMMER_MIN_OPACITY, duration: SHIMMER_PHASE_MS, useNativeDriver: true, isInteraction: false },
  ])
  assert.equal(fake.loops.length, 1)
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

test('ActionRow mounts RN Animated.loop with useNativeDriver on native, respects reduced motion, and cleans up on unmount', () => {
  const source = readFileSync(new URL('./dock.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('export function ActionRow(')
  const end = source.indexOf('\nconst type =', start)
  assert.ok(start >= 0 && end > start, 'ActionRow declaration must exist in dock.tsx')
  const snippet = source.slice(start, end).replace(/^export /, '')
  const { outputText } = ts.transpileModule(snippet, { compilerOptions: { jsx: ts.JsxEmit.React } })

  const fake = createFakeAnimated()
  let reduced = false
  let platformOs: 'ios' | 'android' | 'web' = 'ios'
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

  const render = (props: { doing: string; active?: boolean }) => {
    refCursor = 0
    return ActionRow({ bot: { id: 'b1', name: 'Bot' }, p: { main: '#fff', ink2: '#666' }, dark: false, ...props })
  }

  // Initial native mount starts one native-driver loop.
  const firstTree = render({ doing: 'Thinking' })
  assert.equal(fake.values.length, 1)
  assert.equal(fake.loops.length, 1)
  assert.equal(fake.loops[0].starts, 1)
  assert.equal(fake.timings[0].useNativeDriver, true)
  assert.equal(firstTree.children[1].type, 'Animated.Text')

  // Updating doing text reuses the same Animated.Value without restarting the loop.
  render({ doing: 'Reading files' })
  assert.equal(fake.values.length, 1)
  assert.equal(fake.loops.length, 1)

  // Enabling reduced motion stops the active loop and holds opacity at 1.
  reduced = true
  render({ doing: 'Reading files' })
  assert.equal(fake.loops[0].stops, 1)
  assert.equal(fake.loops.length, 1)
  assert.equal(fake.values[0].current, SHIMMER_STATIC_OPACITY)

  // Disabling reduced motion starts a new loop, and web disables useNativeDriver cleanly.
  reduced = false
  platformOs = 'web'
  render({ doing: 'Writing code' })
  assert.equal(fake.loops.length, 2)
  assert.equal(fake.loops[1].starts, 1)
  assert.equal(fake.timings.at(-1)?.useNativeDriver, false)

  // Pausing via active=false stops the loop without unmounting.
  render({ doing: 'Writing code', active: false })
  assert.equal(fake.loops[1].stops, 1)
  assert.equal(fake.values[0].current, SHIMMER_STATIC_OPACITY)

  // Unmounting cleans up any running loop cleanly.
  platformOs = 'android'
  render({ doing: 'Finishing', active: true })
  assert.equal(fake.loops.length, 3)
  assert.equal(fake.timings.at(-1)?.useNativeDriver, true)
  cleanup?.()
  assert.equal(fake.loops[2].stops, 1)
})

test('mobile/src contains zero Reanimated withRepeat looping animations', () => {
  const mobileSrc = fileURLToPath(new URL('../..', import.meta.url))
  const files = walkTsFiles(mobileSrc)
  assert.ok(files.length > 0, 'expected TypeScript sources under mobile/src')
  const offenders: string[] = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.JSX, content)
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.Identifier && scanner.getTokenText() === 'withRepeat') {
        offenders.push(file)
        break
      }
    }
  }
  assert.deepEqual(offenders, [], 'infinite Reanimated withRepeat loops must use RN Animated.loop instead')
})
