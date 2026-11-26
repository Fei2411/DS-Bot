const drafts = new Map<string, string>()

export function draftTextOf(chatKey: string): string {
  return drafts.get(chatKey) ?? ''
}

export function keepDraftText(chatKey: string, text: string): void {
  if (text === '') drafts.delete(chatKey)
  else drafts.set(chatKey, text)
}
