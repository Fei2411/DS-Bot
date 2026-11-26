import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const primitives = fileURLToPath(new URL('./ui/src/primitives.js', import.meta.url))
const appResolved = new Map([
  ['@deepseek-ai/dsh-llm/assistant-stream', fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))],
  ['@deepseek-ai/dsh-util-values', fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))],
  ['qrcode-generator', fileURLToPath(import.meta.resolve('qrcode-generator'))],
  ['deep-view/react', fileURLToPath(import.meta.resolve('deep-view/react'))],
  ['deep-view/core', fileURLToPath(import.meta.resolve('deep-view/core'))],
])

// The plugin's Bot views take DSH's interface primitives from one module; the window does
// not load DSH's interface, so its own module stands in for that one. Bare packages imported
// by ../ds-bot/src/client/ also resolve from app/node_modules so CI packaging works without
// a separate ds-bot/node_modules install.
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    const norm = source.replaceAll('\\', '/')
    if ((norm === './dsh-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/'))
      || norm.endsWith('/ds-bot/src/client/dsh-primitives.js')) return primitives
    return appResolved.get(source) ?? null
  },
}

// The window loads the build from the app's own scheme, so asset paths stay relative.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  plugins: [ownPrimitives],
  // The Bot views come from the plugin's interface code in ../ds-bot, which has no React
  // of its own.
  resolve: { dedupe: ['react', 'react-dom'] },
  // Code-split heavy vendor, locale, and on-demand page chunks cleanly for fast startup.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'vendor-markdown', test: /node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile|property-information|comma-separated-tokens|space-separated-tokens)/, priority: 25 },
            { name: 'vendor-xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 24 },
            { name: 'vendor-deep-view', test: /node_modules[\\/]deep-view[\\/]/, priority: 23 },
            { name: 'ds-bot-locales', test: /ds-bot[\\/]src[\\/]client[\\/](?:locales[\\/]|i18n\.js)/, priority: 20 },
          ],
        },
      },
    },
  },
})
