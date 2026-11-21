import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('drawer swipe is a non-overlay ancestor and only opens for deliberate right swipes on Chat', () => {
  const source = readFileSync(new URL('./Drawer.tsx', import.meta.url), 'utf8')
  assert.match(source, /enabled\(!shown && edgeEnabled\)/)
  assert.match(source, /activeOffsetX\(24\)/)
  assert.match(source, /failOffsetX\(-8\)/)
  assert.match(source, /failOffsetY\(\[-12, 12\]\)/)
  assert.match(source, /start\.absoluteX < 20/)
  assert.match(source, /start\.absoluteX > screenWidth \/ 2/)
  assert.match(source, /e\.numberOfTouches !== 1 \|\| !start/)
  assert.match(source, /manager\.fail\(\)/)
  assert.match(source, /e\.translationX >= 60 \|\| e\.velocityX > 350/)
  assert.match(source, /<GestureDetector gesture=\{edgePan\}>\s*<View[^>]*>\{children\}<\/View>/)
  assert.doesNotMatch(source, /styles\.edge/)
  const shell = readFileSync(new URL('./ShellB.tsx', import.meta.url), 'utf8')
  assert.match(shell, /edgeEnabled=\{top === 'Chat'\}/)
})

test('message scrollers keep native scroll priority without activating on touch-down', () => {
  for (const file of ['markdown.tsx', 'view.tsx']) {
    const source = readFileSync(new URL(`../screens/chat/${file}`, import.meta.url), 'utf8')
    assert.match(source, /<GHScrollView\s+horizontal\s+disallowInterruption/)
    assert.doesNotMatch(source, /shouldActivateOnStart/)
  }
})
