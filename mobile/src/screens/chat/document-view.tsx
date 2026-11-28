import { WebView } from 'react-native-webview'
import type { Palette } from '../../ui/tokens.ts'

const color = (value: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback

export function DocumentView({ content, p }: { content: string; p: Palette }) {
  const background = color(p.main, '#ffffff')
  const ink = color(p.ink, '#222222')
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <style>
    body { margin: 20px; background: ${background}; color: ${ink}; font: 16px/1.55 system-ui, sans-serif; overflow-wrap: anywhere }
    :first-child { margin-top: 0 }
    pre { white-space: pre-wrap }
    code, pre { font-family: monospace }
    table { display: block; overflow-x: auto; border-collapse: collapse }
    th, td { padding: .35em .6em; border: 1px solid #888 }
    blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #888 }
    </style></head><body>${content}</body></html>`
  return <WebView source={{ html }} style={{ flex: 1, backgroundColor: background }}
    originWhitelist={['*']} onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
    javaScriptEnabled={false} domStorageEnabled={false} allowFileAccess={false}
    allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
    mixedContentMode="never" />
}
