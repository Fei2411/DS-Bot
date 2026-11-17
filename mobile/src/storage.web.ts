export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 0

export async function getItemAsync(key: string, _options?: unknown): Promise<string | null> {
  return localStorage.getItem(key)
}

export async function setItemAsync(key: string, value: string, _options?: unknown): Promise<void> {
  localStorage.setItem(key, value)
}

export async function deleteItemAsync(key: string, _options?: unknown): Promise<void> {
  localStorage.removeItem(key)
}
