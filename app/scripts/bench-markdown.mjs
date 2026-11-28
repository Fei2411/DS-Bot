#!/usr/bin/env node
// Reproducible streaming Markdown benchmark (W4 / #2472).
//
// Measures end-to-end React 19 `flushSync` + `react-markdown` + KaTeX + `highlight.js` +
// `mini-dom` reconciliation time for 2k / 10k / 40k character replies containing prose,
// lists, fenced code blocks, inline math, and display math (`\[...\]` and `$$...$$`),
// streamed incrementally in `CHUNK_CHARS=80` chunks through `app/ui/src/primitives.js`.
//
// Methodology note: the W4 plan baseline (`28.5 ms / 247 ms / 3647 ms`) measured raw
// Markdown parsing alone; this benchmark measures full React reconciliation + KaTeX +
// highlight.js rendering (where the pre-PR merge-base takes tens of seconds on 40k chars
// and the linearized pipeline completes in ~1.0–1.2 s wall / ~1.4–1.6 s CPU).
//
// Run from repo root or `app/`:
//   node app/scripts/bench-markdown.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { installMiniDom } from '../test/mini-dom.mjs'

installMiniDom()

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = join(__dirname, '..')
const reactEntry = fileURLToPath(import.meta.resolve('react'))
const reactDomEntry = fileURLToPath(import.meta.resolve('react-dom'))
const reactDomClientEntry = fileURLToPath(import.meta.resolve('react-dom/client'))
const reactMarkdownEntry = fileURLToPath(import.meta.resolve('react-markdown'))

const dir = mkdtempSync(join(tmpdir(), 'dsb-md-bench-'))
try {
  const shimPath = join(dir, 'counting-markdown.mjs')
  writeFileSync(shimPath, `
import RealMarkdown from ${JSON.stringify(reactMarkdownEntry)}
export default function CountingMarkdown(props) {
  globalThis.__mdParseCount = (globalThis.__mdParseCount || 0) + 1
  return RealMarkdown(props)
}
`)

  const entryCode = `
    export { createElement } from 'react'
    export { createRoot } from 'react-dom/client'
    export { flushSync } from 'react-dom'
    export { MarkdownText } from './ui/src/primitives.js'
    export { ensureKatex } from './ui/src/math-render.js'
    export { ensureLanguage } from './ui/src/code-highlight.js'
  `

  const { outputFiles } = await build({
    stdin: { contents: entryCode, resolveDir: appDir, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    nodePaths: [join(appDir, 'node_modules')],
    plugins: [{
      name: 'md-bench-resolve',
      setup(bundler) {
        bundler.onResolve({ filter: /^react$/ }, () => ({ path: reactEntry }))
        bundler.onResolve({ filter: /^react-dom$/ }, () => ({ path: reactDomEntry }))
        bundler.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomClientEntry }))
        bundler.onResolve({ filter: /^react-markdown$/ }, () => ({ path: shimPath }))
      },
    }],
  })

  const bundlePath = join(dir, 'bundle.mjs')
  writeFileSync(bundlePath, outputFiles[0].text)
  const { createElement: h, createRoot, flushSync, MarkdownText, ensureKatex, ensureLanguage } = await import(pathToFileURL(bundlePath).href)

  await ensureKatex()
  await ensureLanguage('javascript')
  await ensureLanguage('python')

  const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' } }

  function buildReply(targetChars) {
    const sections = []
    let index = 1
    let length = 0
    while (length < targetChars) {
      const useLatexDisplay = index % 2 === 1
      const displayMath = useLatexDisplay
        ? `\\[\n\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6} + ${index}\n\\]`
        : `$$\n\\int_0^{${index}} x^2\\,dx = \\frac{${index}^3}{3}\n$$`
      const block = [
        `## Section ${index}`,
        '',
        `Paragraph ${index} explains the derivation with inline math $E_${index} = m c^2$, LaTeX \\(\\alpha_${index} + \\beta\\), currency $5 and $10, and **formatted** \`inline_code_${index}\`.`,
        '',
        displayMath,
        '',
        '- First observation about throughput and incremental rendering.',
        '- Second observation covering fenced code blocks and math caching.',
        '',
        index % 2 === 1
          ? [
              '```javascript',
              `export function step${index}(items) {`,
              `  const total = items.reduce((acc, item) => acc + item.weight, ${index})`,
              '  return total > 0 ? total / items.length : 0',
              '}',
              '```',
            ].join('\n')
          : [
              '```python',
              `def compute_${index}(values):`,
              `    scale = ${index} * 1.5`,
              '    return [v * scale for v in values if v > 0]',
              '```',
            ].join('\n'),
        '',
      ].join('\n')
      sections.push(block)
      length += block.length + 1
      index += 1
    }
    return sections.join('\n').slice(0, targetChars)
  }

  function runCase(targetChars, chunkChars) {
    const fullText = buildReply(targetChars)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    globalThis.__mdParseCount = 0
    const timings = []
    const cpuStart = process.cpuUsage()
    try {
      for (let end = chunkChars; end < fullText.length; end += chunkChars) {
        const slice = fullText.slice(0, end)
        const t0 = performance.now()
        flushSync(() => root.render(h(MarkdownText, { text: slice, streaming: true, labels })))
        timings.push(performance.now() - t0)
      }
      const tFinal = performance.now()
      flushSync(() => root.render(h(MarkdownText, { text: fullText, streaming: false, labels })))
      timings.push(performance.now() - tFinal)
    } finally {
      root.unmount()
      container.remove()
    }
    const cpuDelta = process.cpuUsage(cpuStart)
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
    const totalMs = timings.reduce((sum, ms) => sum + ms, 0)
    const sorted = [...timings].sort((a, b) => a - b)
    const round2 = v => Math.round(v * 100) / 100
    return {
      chars: fullText.length,
      chunks: timings.length,
      mdParses: globalThis.__mdParseCount,
      cpuMs: round2(cpuMs),
      totalMs: round2(totalMs),
      meanMs: round2(totalMs / timings.length),
      p95Ms: round2(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxMs: round2(sorted.at(-1) ?? 0),
    }
  }

  const chunkChars = Number(process.env.CHUNK_CHARS ?? 80)
  // Warmup JIT
  runCase(1000, chunkChars)

  const sizes = [2000, 10000, 40000]
  const results = sizes.map(size => runCase(size, chunkChars))
  console.log(JSON.stringify({ chunkChars, results }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
