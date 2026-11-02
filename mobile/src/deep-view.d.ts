declare module 'deep-view/core' {
  export function compileFormula(source: string): unknown
  export function createScope(inputs: Map<string, unknown>, lets: Map<string, unknown>): (name: string) => unknown
  export function evaluate(tree: unknown, lookup: (name: string) => unknown): { value: unknown } | { error: string }
  export function isFormula(value: unknown): boolean
  export function choiceValue(option: unknown): unknown
}
