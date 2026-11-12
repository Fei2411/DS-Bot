// Builds link.js, the phone link that src/host/phone.js runs, from the shared code in ../link/src.
//
//   node scripts/build-link.mjs           writes link.js
//   node scripts/build-link.mjs --check   exits 1 when link.js differs from a fresh build
//
// link.js is committed with its crypto libraries inside, so the plugin installs with no
// dependencies of its own, as client.js does. The build needs `npm ci` in ../link.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'link.js')

export async function bundleLink() {
  const result = await build({
    absWorkingDir: join(PLUGIN, '..', 'link'),
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'inline',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return `// Generated from ../link/src by \`npm run build\` (scripts/build-link.mjs). Do not edit by hand.\n${result.outputFiles[0].text}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleLink()
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== next) {
      console.error('link.js is stale: run `npm run build` in ds-bot and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
  }
}
