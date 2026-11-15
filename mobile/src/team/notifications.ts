export function androidNotificationStatus(sdk: number, granted: boolean): 'Allowed' | 'Allow' | undefined {
  if (sdk < 33) return undefined
  return granted ? 'Allowed' : 'Allow'
}
