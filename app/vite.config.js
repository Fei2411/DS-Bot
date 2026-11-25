import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const primitives = fileURLToPath(new URL('./ui/src/primitives.js', import.meta.url))
const assistantStream = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm/assistant-stream'))
const utilValues = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-util-values'))

// The plugin's Bot views take DSH's interface primitives from one module; the window does
// not load DSH's interface, so its own module stands in for that one.
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    const norm = source.replaceAll('\\', '/')
    if ((norm === './dsh-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/'))
      || norm.endsWith('/ds-bot/src/client/dsh-primitives.js')) return primitives
    if (source === '@deepseek-ai/dsh-llm/assistant-stream') return assistantStream
    if (source === '@deepseek-ai/dsh-util-values') return utilValues
    return null
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
            { name: 'ds-bot-locales', test: /ds-bot[\\/]src[\\/]client[\\/]locales[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
})
