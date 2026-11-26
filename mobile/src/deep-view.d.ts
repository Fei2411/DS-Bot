declare module 'deep-view/core' {
  export function compileFormula(source: string): { tree: unknown; names: string[] } | { error: string }
  export function createScope(inputs: Map<string, unknown>, lets: Map<string, unknown>): (name: string) => unknown
  export function evaluate(tree: unknown, lookup: (name: string) => unknown): { value: unknown } | { error: string }
  export function isFormula(value: unknown): boolean
  export function choiceValue(option: unknown): unknown
  export function show(value: unknown): string
  export function viewAnswerText(view: unknown, answer: unknown): string
  export function validateViewAnswer(view: unknown, action: unknown, values: unknown): { error?: string }
}
