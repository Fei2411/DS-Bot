export function computerAccessTitle(translate, ask, name) {
  const args = { name, app: ask.appName ?? '' }
  if (ask.operation === 'foreground') return translate('Allow {name} to control {app} in the foreground?', args)
  if (ask.operation === 'background') return translate('Allow {name} to control {app} in the background?', args)
  return translate('Allow {name} to use {app}?', args)
}
