export function confirmDanger(title: string, _action: string, onConfirm: () => void, message?: string) {
  if (window.confirm([title, message].filter(Boolean).join('\n\n'))) onConfirm()
}
