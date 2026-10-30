#!/usr/bin/env node
// Read-only: collects the open issues and pull requests and writes a digest for triage.
// Usage: node .agents/skills/issue-triage/scripts/snapshot.mjs [--out <dir>] [--repo <owner/name>]
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const out = resolve(option('--out', join(tmpdir(), 'issue-triage')))
const repo = option('--repo', 'Fei2411/DS-Bot')

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 1 << 28 })
const gh = cmdArgs => JSON.parse(run('gh', [...cmdArgs, '--repo', repo]))

const TYPES = ['bug', 'enhancement', 'documentation']
const PRIORITY = /^P[0-3]$/
const STALE_DAYS = 14
const DAY = 86400000

const issues = gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,labels,author,assignees,createdAt,body,comments'])
const pulls = gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,author,baseRefName'])
const open = new Set(issues.map(issue => issue.number))

// `#123` that is not part of a color, a hash or a longer word.
const refsIn = text => [...new Set([...String(text ?? '').matchAll(/(?<![\w&])#(\d{1,5})\b/g)].map(match => Number(match[1])))].filter(n => open.has(n))
const flat = text => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
const days = iso => Math.floor((Date.now() - new Date(iso).getTime()) / DAY)

const pullRefs = new Map()
for (const pull of pulls) for (const n of refsIn(`${pull.title}\n${pull.body}`)) pullRefs.set(n, [...(pullRefs.get(n) ?? []), pull.number])

// Commits on dev and main that name an issue: the cheapest evidence that it is fixed.
const commitRefs = new Map()
for (const branch of ['origin/dev', 'origin/main']) {
  let log = ''
  try { log = run('git', ['log', branch, '-n', '3000', '--format=%h%x1f%s%x1f%b%x1e']) } catch { continue }
  for (const entry of log.split('\x1e')) {
    const [hash, subject = '', body = ''] = entry.trim().split('\x1f')
    if (!hash) continue
    for (const n of refsIn(`${subject}\n${body}`)) {
      const list = commitRefs.get(n) ?? []
      if (list.length < 3 && !list.some(item => item.startsWith(hash))) list.push(`${hash} (${branch.slice(7)}) ${subject.slice(0, 90)}`)
      commitRefs.set(n, list)
    }
  }
}

const rows = issues.map(issue => {
  const labels = issue.labels.map(label => label.name)
  const priorities = labels.filter(name => PRIORITY.test(name))
  const lastByReporter = issue.comments.filter(comment => comment.author.login === issue.author.login).at(-1)?.createdAt ?? issue.createdAt
  const problems = []
  if (!labels.some(name => TYPES.includes(name))) problems.push('no type')
  if (priorities.length === 0) problems.push('no priority')
  if (priorities.length > 1) problems.push(`priorities ${priorities.join('+')}`)
  if (labels.includes('needs-info') && days(lastByReporter) > STALE_DAYS) problems.push(`needs-info, reporter silent ${days(lastByReporter)}d`)
  return { number: issue.number, title: issue.title, labels, priority: priorities[0], author: issue.author.login, assignees: issue.assignees.map(a => a.login), age: days(issue.createdAt), comments: issue.comments, body: issue.body, problems, pulls: pullRefs.get(issue.number) ?? [], commits: commitRefs.get(issue.number) ?? [] }
})
const rank = row => (row.problems.length ? 0 : 1) * 10 + (row.priority ? Number(row.priority[1]) : 5)
rows.sort((a, b) => rank(a) - rank(b) || b.number - a.number)

const lines = [`# Triage snapshot ${new Date().toISOString().slice(0, 10)} · ${repo}`, '']
const todo = rows.filter(row => row.problems.length)
lines.push(`Open issues: ${rows.length} · open pull requests: ${pulls.length} · to handle: ${todo.length}`, '')
if (todo.length) {
  lines.push('## To handle', '')
  for (const row of todo) lines.push(`- #${row.number} ${row.problems.join(', ')}: ${flat(row.title).slice(0, 80)}`)
  lines.push('')
}
lines.push('## Issues', '')
for (const row of rows) {
  lines.push(`### #${row.number} [${row.labels.join(', ') || '-'}] ${row.age}d · ${row.comments.length} comments · @${row.author}${row.assignees.length ? ` → ${row.assignees.join(', ')}` : ''}`)
  lines.push(`T: ${flat(row.title)}`)
  const body = flat(row.body).slice(0, 240)
  if (body) lines.push(`B: ${body}`)
  const others = row.comments.filter(comment => comment.author.login !== row.author).slice(-2).map(comment => `@${comment.author.login}: ${flat(comment.body).slice(0, 160)}`)
  if (others.length) lines.push(`C: ${others.join(' || ')}`)
  if (row.commits.length) lines.push(`FIX: ${row.commits.join(' ;; ')}`)
  if (row.pulls.length) lines.push(`PR: ${row.pulls.map(n => `#${n}`).join(' ')}`)
  lines.push('')
}
const loose = pulls.filter(pull => refsIn(`${pull.title}\n${pull.body}`).length === 0)
if (loose.length) {
  lines.push('## Open pull requests without an open issue', '')
  for (const pull of loose) lines.push(`- #${pull.number} → ${pull.baseRefName} @${pull.author.login}: ${flat(pull.title).slice(0, 90)}`)
  lines.push('')
}

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'snapshot.json'), JSON.stringify({ generatedAt: new Date().toISOString(), repo, issues: rows.map(({ comments, ...row }) => ({ ...row, comments: comments.length })), pulls }, null, 1))
writeFileSync(join(out, 'digest.md'), `${lines.join('\n')}\n`)
console.log(`${out}: ${rows.length} issues, ${pulls.length} pull requests, ${todo.length} to handle`)
