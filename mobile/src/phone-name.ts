export function phoneName(os: string, constants?: { Manufacturer?: string; Model?: string; interfaceIdiom?: string }): string {
  if (os === 'web') return 'Web browser'
  if (os === 'android') return [constants?.Manufacturer, constants?.Model].filter(Boolean).join(' ') || 'Android phone'
  return constants?.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone'
}
