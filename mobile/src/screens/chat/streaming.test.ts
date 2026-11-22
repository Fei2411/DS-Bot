import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('Streaming clears all attempts on hello before rebuilding from replay', () => {
  const source = readFileSync(new URL('../Chat.tsx', import.meta.url), 'utf8')
  const component = source.slice(source.indexOf('function Streaming('), source.indexOf('\nconst type ='))
  const { outputText } = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.React } })
  let listener: (event: string, data?: any) => void = () => {}
  let text = ''
  const render = runInNewContext(`${outputText}\nStreaming`, {
    useTeam: () => ({ onFeed: (fn: typeof listener) => { listener = fn; return () => {} } }),
    useState: () => [text, (value: string) => { text = value }],
    useEffect: (fn: () => void) => fn(),
  })
  render({ sessionId: 's1' })
  const emit = (data: any) => listener('stream', { sessionId: 's1', attemptId: 'a1', ...data })
  emit({ phase: 'start' })
  emit({ text: 'Before' })
  assert.equal(text, 'Before')
  listener('hello', {})
  assert.equal(text, '')
  emit({ phase: 'start' })
  emit({ text: 'BeforeGap' })
  assert.equal(text, 'BeforeGap')
  emit({ text: 'After' })
  assert.equal(text, 'BeforeGapAfter')
  listener('hello', {})
  emit({ phase: 'start', attemptId: 'a2' })
  emit({ text: 'New reply', attemptId: 'a2' })
  assert.equal(text, 'New reply')
  emit({ phase: 'end', attemptId: 'a2' })
  assert.equal(text, '')
  listener('stream', { sessionId: 'other', text: 'ignored' })
  assert.equal(text, '')
})
