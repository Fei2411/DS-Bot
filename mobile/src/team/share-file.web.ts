export async function shareFile(saved: { uri: string; name: string; mime: string }): Promise<void> {
  const link = document.createElement('a')
  link.href = saved.uri
  link.download = saved.name
  document.body.appendChild(link)
  try { link.click() } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(saved.uri), 60_000)
  }
}
