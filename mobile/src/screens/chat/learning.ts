export interface LearningProposal {
  id: string
  botId: string
  kind?: string
  action?: string
  name?: string
  description?: string
  content?: string
  previous?: { content?: string }
  why?: string
  folder?: string
  edits?: { op: string; old?: string; text?: string; why?: string }[]
}

export function learningForChat(learning: Record<string, LearningProposal[]> | undefined, botId: string | undefined, current: string | undefined, sessionId: string): LearningProposal[] {
  return botId !== undefined && current === sessionId ? learning?.[botId] ?? [] : []
}
