// What the custom-provider form still needs before it can be sent. Kept free of React
// so the same rule is testable, and the form can name what is missing instead of only
// greying out its Add button.
export function providerFormMissing(draft, models) {
  const missing = []
  if (String(draft?.provider ?? '').trim() === '') missing.push('provider')
  if (String(draft?.baseURL ?? '').trim() === '') missing.push('endpoint')
  if ((models ?? []).length === 0) missing.push('model')
  return missing
}
