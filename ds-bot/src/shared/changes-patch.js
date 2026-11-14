// Render the service's recorded hunks without re-reading or recomputing files.
export function changesPatch(diff) {
  if (diff.kind !== 'text') return ''
  const lines = [`--- ${diff.before ? `a/${diff.display}` : '/dev/null'}`, `+++ ${diff.after ? `b/${diff.display}` : '/dev/null'}`]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines)
  }
  const patch = lines.join('\n')
  const fence = '`'.repeat(Math.max(3, ...[...patch.matchAll(/`+/g)].map(match => match[0].length + 1)))
  return `${fence}diff\n${patch}\n${fence}`
}
