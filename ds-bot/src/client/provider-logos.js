// Auto-matched provider marks for model lists and Usage views. Reuses the verified
// vector paths already bundled in agent-logos.js and adds monochrome geometric marks
// drawn in currentColor so every badge follows the active Light/Dark theme cleanly.
import { createElement as h } from 'react'
import { AGENT_LOGOS } from './agent-logos.js'

const MATCHERS = [
  ['deepseek', /\bdeepseek\b|deep[\s_-]?seek/i],
  ['openai', /\bopenai\b|\bchatgpt\b|\bcodex\b|(^|[/:\s_-])(gpt|o1|o3|o4)([-\d.]|$)/i],
  ['anthropic', /\banthropic\b|\bclaude\b/i],
  ['google', /\bgoogle\b|\bgemini\b|\bvertex\b|\bgemma\b/i],
  ['xai', /\bxai\b|\bx\.ai\b|\bgrok\b/i],
  ['qwen', /\bqwen\b|\bdashscope\b|\balibaba\b|\baliyun\b|\bbailian\b|\btongyi\b/i],
  ['kimi', /\bmoonshot\b|\bkimi\b/i],
  ['zhipu', /\bzhipu\b|\bbigmodel\b|\bchatglm\b|\bglm\b|\bz\.ai\b/i],
  ['minimax', /\bminimax\b|\babab\d/i],
  ['mistral', /\bmistral\b|\bcodestral\b|\bmixtral\b|\bpixtral\b|\bdevstral\b/i],
  ['meta', /\bmeta\b|\bllama\b/i],
  ['openrouter', /\bopenrouter\b/i],
  ['ollama', /\bollama\b/i],
  ['groq', /\bgroq\b/i],
  ['volcengine', /\bvolcengine\b|\bvolcano\b|\bdoubao\b|\bbytedance\b|\bark\b/i],
  ['siliconflow', /\bsiliconflow\b|\bsiliconcloud\b/i],
  ['cohere', /\bcohere\b|\bcommand[-\s]?r\b/i],
  ['perplexity', /\bperplexity\b|\bsonar\b/i],
  ['github', /\bgithub\b|\bcopilot\b/i],
  ['bedrock', /\bbedrock\b|\bamazon\b|\baws\b|\bnova\b/i],
  ['azure', /\bazure\b/i],
  ['together', /\btogether\b/i],
  ['fireworks', /\bfireworks\b/i],
]

/**
 * Resolves a canonical provider logo id from provider/model metadata.
 * Checks explicit provider fields first, then falls back to model name/id so
 * aggregators or custom aliases still get the underlying model family's mark.
 */
export function matchProviderId({ provider, providerName, model, name } = {}) {
  const providerText = [provider, providerName].filter(Boolean).join(' ')
  if (providerText !== '') {
    for (const [id, pattern] of MATCHERS) {
      if (pattern.test(providerText)) return id
    }
  }
  const modelText = [model, name].filter(Boolean).join(' ')
  if (modelText !== '') {
    for (const [id, pattern] of MATCHERS) {
      if (pattern.test(modelText)) return id
    }
  }
  return null
}

const agentPath = key => AGENT_LOGOS[key]?.d

const PATH_MARKS = {
  // Reuse verified monochrome 24x24 vector paths from agent-logos.js.
  anthropic: agentPath('claude-code'),
  google: agentPath('gemini-cli'),
  qwen: agentPath('qwen-code'),
  kimi: agentPath('kimi-cli'),
  minimax: agentPath('minimax-code'),
  mistral: agentPath('mistral-vibe'),
  github: agentPath('copilot-cli'),
  // Original geometric silhouette marks drawn in 24x24 currentColor.
  xai: 'M3.5 3h4.2l4.8 6.9L17.4 3H21l-6.6 8.8L21.5 21h-4.2l-5.2-7.4L6.7 21H3l7.1-9.3L3.5 3Z',
  zhipu: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13a1.5 1.5 0 0 1 1.2 2.4L10.3 17H18.5a1.5 1.5 0 0 1 0 3h-13a1.5 1.5 0 0 1-1.2-2.4L13.7 7H5.5A1.5 1.5 0 0 1 4 5.5Z',
  azure: 'M13.6 3 4.2 19.2h4.9l2.4-4.3 4.1 4.3h4.6L13.6 3Zm-.6 6.2 2.9 6.6h-5.3l2.4-6.6Z',
  siliconflow: 'M12 2.5 20.5 7.5 12 12.5 3.5 7.5 12 2.5Zm0 12.3 6.9-4.1 1.6.9L12 16.6l-8.5-5 1.6-.9 6.9 4.1Zm0 4 6.9-4.1 1.6.9-8.5 5-8.5-5 1.6-.9 6.9 4.1Z',
  volcengine: 'M12 3.2 21 19.5h-4.6l-4.4-8.2-4.4 8.2H3L12 3.2Zm0 10.1 2.7 6.2H9.3l2.7-6.2Z',
}

// Official DeepSeek whale mark (23.16 x 17.04) centered inside a square viewBox with breathing room.
const DEEPSEEK_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

function renderMark(id, size) {
  if (id === 'deepseek') {
    return h('svg', { width: size, height: size, viewBox: '-0.5 -3.56 24.16 24.16', fill: 'currentColor', 'aria-hidden': true },
      h('path', { d: DEEPSEEK_PATH }))
  }
  const path = PATH_MARKS[id]
  if (path) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
      h('path', { d: path }))
  }
  const strokeProps = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.85, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  }
  switch (id) {
    case 'openai':
      return h('svg', strokeProps,
        h('path', { d: 'M12 3.5a4 4 0 0 1 3.8 2.8A4 4 0 0 1 19 11.4a4 4 0 0 1-1.4 5.4A4 4 0 0 1 12 20.5a4 4 0 0 1-3.8-2.8A4 4 0 0 1 5 12.6a4 4 0 0 1 1.4-5.4A4 4 0 0 1 12 3.5Z' }),
        h('polygon', { points: '12,8.4 15.1,10.2 15.1,13.8 12,15.6 8.9,13.8 8.9,10.2' }))
    case 'meta':
      return h('svg', strokeProps,
        h('path', { d: 'M4.5 14.5c0-3.2 1.8-6.5 4.2-6.5 1.7 0 2.7 1.7 3.3 3.1.6-1.4 1.6-3.1 3.3-3.1 2.4 0 4.2 3.3 4.2 6.5 0 2-1.1 3.2-2.6 3.2-1.6 0-2.8-1.4-4.9-5-2.1 3.6-3.3 5-4.9 5-1.5 0-2.6-1.2-2.6-3.2Z' }))
    case 'openrouter':
      return h('svg', strokeProps,
        h('path', { d: 'M4 12h5.5l4-5.5H20' }),
        h('path', { d: 'M9.5 12l4 5.5H20' }),
        h('path', { d: 'M17.5 4.2 20 6.5l-2.5 2.3' }),
        h('path', { d: 'M17.5 15.2 20 17.5l-2.5 2.3' }))
    case 'ollama':
      return h('svg', strokeProps,
        h('path', { d: 'M8 5.5c0-1.4.8-2.3 1.7-2.3s1.5.9 1.5 2.3v1.8h1.6V5.5c0-1.4.8-2.3 1.7-2.3s1.5.9 1.5 2.3v5.1c1.3 1 2 2.5 2 4.3 0 3-2.6 5.4-6 5.4s-6-2.4-6-5.4c0-1.8.7-3.3 2-4.3V5.5Z' }),
        h('circle', { cx: 10, cy: 13.4, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 14, cy: 13.4, r: 0.7, fill: 'currentColor', stroke: 'none' }))
    case 'groq':
      return h('svg', strokeProps,
        h('path', { d: 'M18.2 8.2A7.5 7.5 0 1 0 19.5 12h-7' }),
        h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor', stroke: 'none' }))
    case 'cohere':
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('rect', { x: 4, y: 5.5, width: 14, height: 5.5, rx: 2.75 }),
        h('rect', { x: 4, y: 13, width: 7.5, height: 5.5, rx: 2.75 }),
        h('circle', { cx: 16.8, cy: 15.75, r: 2.75 }))
    case 'perplexity':
      return h('svg', strokeProps,
        h('path', { d: 'M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9' }),
        h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }))
    case 'bedrock':
      return h('svg', strokeProps,
        h('path', { d: 'M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z' }),
        h('path', { d: 'M12 12 20 7.5M12 12 4 7.5M12 12v9' }))
    case 'together':
      return h('svg', strokeProps,
        h('circle', { cx: 9, cy: 10, r: 3.5 }),
        h('circle', { cx: 15, cy: 10, r: 3.5 }),
        h('circle', { cx: 12, cy: 15.2, r: 3.5 }))
    case 'fireworks':
      return h('svg', strokeProps,
        h('path', { d: 'M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2' }),
        h('circle', { cx: 12, cy: 12, r: 2, fill: 'currentColor', stroke: 'none' }))
    default:
      return null
  }
}

/**
 * Renders an auto-matched provider logo SVG when recognized, or null for fallback monogram.
 */
export function ProviderLogo({ provider, providerName, model, name, size = 18 }) {
  const id = matchProviderId({ provider, providerName, model, name })
  if (id === null) return null
  return renderMark(id, size)
}
