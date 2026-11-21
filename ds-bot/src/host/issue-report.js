import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkShownView } from 'deep-view/core'
import { cleanText, ISSUES_URL } from './diagnostics.js'
import { output } from './tools.js'

export const PUBLISH_ISSUE = 'publish_ds_bot_issue'
const DRAFT_TTL = 10 * 60_000
const LINK_MAX = 4000

function issueLink({ title, body }) {
  const link = value => `${ISSUES_URL}?${new URLSearchParams({ title, body: value })}`
  if (link(body).length <= LINK_MAX) return link(body)
  const chars = Array.from(body)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (link(`${chars.slice(0, mid).join('')}…`).length <= LINK_MAX) low = mid
    else high = mid - 1
  }
  return link(`${chars.slice(0, low).join('')}…`)
}

export function install(rt) {
  const drafts = new Map()
  const inOwnChat = id => rt.chatOwners.has(id) && !rt.groupOwners.has(id) && !rt.taskOwners?.has(id)

  rt.teamTools.push(defineTool({
    name: 'prepare_ds_bot_issue',
    description: 'Prepare a public DS Bot bug report for the user to review. Read the report-ds-bot-issue skill first. This does not publish anything.',
    parameters: {
      title: { type: 'string', required: true, description: 'A short issue title (up to 120 characters)' },
      what: { type: 'string', required: true, description: 'What happened, the expected result, and any relevant redacted error' },
      steps: { type: 'string', required: true, description: 'Steps to reproduce, without private data' },
      diagnostics: { type: 'string', description: 'Relevant, redacted details known to the user; DS Bot version and OS are added automatically' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sessionId = exec.agent?.id
      if (!inOwnChat(sessionId)) return 'Prepare a DS Bot report in your own chat so the user can review it there.'
      await rt.loadSecrets()
      const clean = value => {
        let text = cleanText(value, { redact: rt.redactSecrets })
        for (const home of [rt.dshHome, rt.home]) text = cleanText(text, { home })
        return text.replace(/\r\n?/g, '\n').trim()
      }
      const title = clean(args.title).replace(/\s+/g, ' ')
      const what = clean(args.what)
      const steps = clean(args.steps)
      const diagnostics = [clean(rt.diagnostics.issueFacts()), clean(args.diagnostics)].filter(Boolean).join('\n')
      if (title === '' || title.length > 120 || what === '' || steps === '') return 'Provide a short title, what happened, and steps to reproduce.'
      const body = `### What happened?\n\n${what}\n\n### Steps to reproduce\n\n${steps}\n\n### Diagnostics\n\n${diagnostics}`
      if (body.length > 1900) return 'Shorten the issue draft to fit in the approval card.'
      const fence = '`'.repeat(Math.max(2, ...(body.match(/`+/g) ?? []).map(run => run.length)) + 1)
      const view = {
        type: 'stack',
        children: [
          { type: 'text', tone: 'muted', text: 'This report will be public on Fei2411/DS-Bot. Check that it contains no private information.' },
          { type: 'text', text: `${fence}\n${body}\n${fence}` },
          { type: 'confirm', id: PUBLISH_ISSUE, confirmLabel: 'Publish issue', cancelLabel: 'Cancel' },
        ],
      }
      const checked = checkShownView(title, view)
      if (checked.error !== undefined) return 'Shorten the issue draft to fit in the approval card.'
      const now = Date.now()
      for (const [id, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(id)
      const report_issue = randomUUID()
      drafts.set(sessionId, { id: report_issue, title, body, view: checked.view, expiresAt: now + DRAFT_TTL })
      return `Call show_view with these exact arguments:\n${JSON.stringify({ title, view, report_issue })}`
    },
  }))

  rt.claimIssueDraft = (sessionId, id, { title, view }) => {
    const draft = drafts.get(sessionId)
    if (draft === undefined || draft.id !== id || draft.expiresAt <= Date.now()
      || draft.title !== title || !isDeepStrictEqual(draft.view, view)) return undefined
    drafts.delete(sessionId)
    return { title: draft.title, body: draft.body }
  }

  rt.settleIssueReport = async (sessionId, draft) => {
    let uncertain = false
    try {
      const url = await rt.publishDsBotIssue(rt.chatOwners.get(sessionId), draft)
      if (url !== undefined) return `Issue published: ${url}`
    } catch {
      uncertain = true
    }
    const link = issueLink(draft)
    return uncertain
      ? `Could not confirm whether GitHub published the issue. Check existing issues before submitting manually: ${link}`
      : `Could not publish through the GitHub connector. Review and submit the draft on GitHub: ${link}`
  }
}
