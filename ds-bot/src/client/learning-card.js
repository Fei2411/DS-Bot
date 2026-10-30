import { createElement as h, useId, useMemo, useRef, useState } from 'react'
import { useTurnFacts } from './btw.js'
import { editLines, lineDiff, proposalPlacement } from './learning-card-model.js'
import { currentPart } from './text.js'
import { t } from './i18n.js'
import { CheckIcon, MemoryIcon, PencilIcon } from './icons.js'
import { spring, SPRING_TAP } from './motion.js'

const failedAnswers = new Map()

function ProposalCard({ proposal, initialError = '', onFailure, onResolved, actions }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const busyRef = useRef(false)
  const titleId = useId()
  const answer = approve => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void Promise.resolve().then(() => actions.learningAnswer(proposal.id, approve))
      .then(() => onResolved(proposal.id), failure => {
        const message = failure?.message ?? String(failure)
        setError(message)
        onFailure(proposal, message)
      })
      .finally(() => {
        busyRef.current = false
        setBusy(false)
      })
  }
  const update = proposal.action === 'update'
  const rows = useMemo(() => lineDiff(update ? proposal.previous?.content : '', proposal.content), [update, proposal.previous?.content, proposal.content])
  if (proposal.kind === 'agents') {
    const blocks = proposal.edits.map(edit => [
      ...(edit.op === 'add' ? [] : editLines(edit.old)).map(line => ({ kind: 'removed', line })),
      ...(edit.op === 'remove' ? [] : editLines(edit.text)).map(line => ({ kind: 'added', line })),
    ])
    return h('section', { className: 'bt-q bt-learning-card', role: 'group', 'aria-labelledby': titleId, 'aria-busy': busy },
      h(ProposalHead, { titleId, icon: PencilIcon, title: t('AGENTS.md update') }),
      h(FileBox, { name: 'AGENTS.md', path: proposal.folder, state: proposal.exists === false ? 'Added' : 'Modified', blocks }),
      proposal.edits.map((edit, index) => edit.why ? h('p', { className: 'bt-learning-why', key: index }, edit.why) : null),
      error ? h('div', { className: 'bt-learning-error', role: 'alert' }, error) : null,
      h(ProposalFoot, { busy, answer }))
  }
  const oldDetail = update && typeof proposal.previous?.description === 'string' && proposal.previous.description !== proposal.description ? proposal.previous.description : undefined
  return h('section', { className: 'bt-q bt-learning-card', role: 'group', 'aria-labelledby': titleId, 'aria-busy': busy },
    h(ProposalHead, { titleId, title: proposal.name, kind: t(update ? 'Skill update' : 'New skill'), detail: proposal.description, oldDetail }),
    h(FileBox, { name: 'SKILL.md', path: `skills/${proposal.name}`, state: update ? 'Updated' : 'Added', blocks: [rows] }),
    proposal.why ? h('p', { className: 'bt-learning-why' }, proposal.why) : null,
    error ? h('div', { className: 'bt-learning-error', role: 'alert' }, error) : null,
    h(ProposalFoot, { busy, answer }))
}

function ProposalHead({ titleId, icon = MemoryIcon, title, kind, detail, oldDetail }) {
  return h('div', { className: 'bt-q-head' },
    h('span', { className: 'bt-learning-icon', 'aria-hidden': true }, h(icon)),
    h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title', id: titleId }, title),
      kind ? h('div', { className: 'bt-q-detail' }, kind) : null,
      oldDetail ? h('p', { className: 'bt-learning-description bt-learning-old' }, h('del', null, oldDetail)) : null,
      detail ? h('p', { className: 'bt-learning-description' }, detail) : null),
    h('span', { className: 'bt-q-badge bt-learning-status' }, h('span', { className: 'bt-learning-dot', 'aria-hidden': true }), t('Awaiting approval')))
}

function ProposalFoot({ busy, answer }) {
  return h('div', { className: 'bt-q-foot bt-learning-foot' },
    h('button', { type: 'button', className: 'bt-learning-btn bt-learning-decline', disabled: busy, onClick: () => answer(false) }, t('Decline')),
    h('button', { type: 'button', className: 'bt-learning-btn bt-learning-approve', disabled: busy, onClick: () => answer(true) },
      h(CheckIcon), t('Approve')))
}

const COLLAPSE_ROWS = 8
const SIGNS = { added: '+', removed: '\u2212', same: '' }

function FileBox({ name, path, state, blocks }) {
  const [open, setOpen] = useState(false)
  const all = blocks.flat()
  const added = all.filter(row => row.kind === 'added').length
  const removed = all.filter(row => row.kind === 'removed').length
  const folds = all.length > COLLAPSE_ROWS
  const shut = folds && !open
  return h('div', { className: 'bt-learning-file' },
    h('div', { className: 'bt-learning-filehead' },
      h('span', { className: 'bt-learning-name' }, name),
      path ? h('span', { className: 'bt-learning-path' }, path) : null,
      h('span', { className: 'bt-learning-spacer' }),
      added > 0 ? h('span', { className: 'bt-learning-plus' }, `+${added}`) : null,
      removed > 0 ? h('span', { className: 'bt-learning-minus' }, `\u2212${removed}`) : null,
      h('span', { className: `bt-learning-state bt-learning-state-${state.toLowerCase()}` }, t(state))),
    h('div', { className: shut ? 'bt-learning-code bt-learning-shut' : 'bt-learning-code' },
      blocks.map((rows, blockIndex) => [
        blockIndex > 0 ? h('div', { className: 'bt-learning-gap', key: `gap-${blockIndex}` }) : null,
        ...rows.map((row, rowIndex) => h('div', { className: `bt-learning-row bt-learning-${row.kind}`, key: `${blockIndex}-${rowIndex}` },
          h('span', { className: 'bt-learning-num', 'aria-hidden': true }, row.number ?? ''),
          h('span', { className: 'bt-learning-sign', 'aria-hidden': true }, SIGNS[row.kind]),
          h('span', { className: 'bt-learning-text' }, row.line || '\u00a0'))),
      ])),
    folds ? h('div', { className: shut ? 'bt-learning-morebar bt-learning-morebar-shut' : 'bt-learning-morebar' },
      h('button', { type: 'button', className: 'bt-learning-more', 'aria-expanded': open, onClick: () => setOpen(!open) },
        t(open ? 'Show less' : 'Show all {count} lines', { count: all.length }))) : null)
}

function LearningProposals({ turn, dock, sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const facts = useTurnFacts(sessionId, actions)
  const [failed, setFailed] = useState({})
  const bot = roster.byId?.[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const proposals = roster.learning?.[bot.id] ?? []
  const visible = [...proposals]
  for (const entry of Object.values(failed)) {
    if (entry.proposal.botId === bot.id && !proposals.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  for (const entry of failedAnswers.values()) {
    if (entry.proposal.botId === bot.id && !proposals.some(proposal => proposal.id === entry.proposal.id)
      && !visible.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  const cards = visible.filter(proposal => {
    const placement = proposalPlacement(proposal, facts?.turns)
    return dock ? placement.kind === 'dock' : placement.kind === 'turn' && placement.turn === turn?.turn
  })
  if (cards.length === 0) return null
  const onFailure = (proposal, error) => {
    failedAnswers.set(proposal.id, { proposal, error })
    setFailed(current => ({ ...current, [proposal.id]: { proposal, error } }))
  }
  const onResolved = id => setFailed(current => {
    failedAnswers.delete(id)
    if (!(id in current)) return current
    const next = { ...current }
    delete next[id]
    return next
  })
  return h('div', { className: dock ? 'bt-learning-stack bt-learning-dock' : 'bt-learning-stack' }, cards.map(proposal => h('div', { className: 'bt-q-inline', key: proposal.id },
    h(ProposalCard, {
      proposal,
      initialError: failed[proposal.id]?.error ?? failedAnswers.get(proposal.id)?.error,
      onFailure,
      onResolved,
      actions,
    }))))
}

export function LearningTurnTail(props) {
  return h(LearningProposals, { ...props, dock: false })
}

export function LearningDock(props) {
  return h(LearningProposals, { ...props, dock: true })
}

export const LEARNING_CSS = `
.bt-learning-stack{display:flex;flex-direction:column;gap:4px}
.bt-learning-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;box-sizing:border-box}
.bt-learning-card .bt-q-head{gap:12px}
.bt-learning-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-learning-icon svg{width:18px;height:18px}
.bt-learning-description{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--bt-ink)}
.bt-learning-old{color:var(--bt-ink-3)}
.bt-learning-status{display:inline-flex;align-items:center;gap:6px;border-style:solid;border-color:color-mix(in srgb,var(--bt-star) 35%,transparent);color:color-mix(in srgb,var(--bt-star) 80%,var(--bt-ink))}
.bt-learning-dot{width:6px;height:6px;border-radius:50%;background:var(--bt-star)}
.bt-learning-file{border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--bt-ink) 2.5%,var(--bt-card));box-shadow:inset 0 0 0 1px var(--bt-q-rule)}
.bt-learning-filehead{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 12px;box-shadow:inset 0 -1px 0 var(--bt-q-rule-2);font-size:12px;line-height:18px}
.bt-learning-name{flex:none;font-weight:600;color:var(--bt-ink)}
.bt-learning-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-3)}
.bt-learning-spacer{flex:1}
.bt-learning-plus,.bt-learning-minus{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.bt-learning-plus{color:var(--bt-green)}
.bt-learning-minus{color:var(--bt-danger)}
.bt-learning-state{flex:none;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;font-weight:500;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-learning-state-added{background:color-mix(in srgb,var(--bt-green) 13%,transparent);color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-learning-code{padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:20px;color:var(--bt-ink)}
.bt-learning-shut{max-height:172px;overflow:hidden}
.bt-learning-row{display:grid;grid-template-columns:36px 16px 1fr}
.bt-learning-num{padding-right:6px;text-align:right;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;user-select:none}
.bt-learning-sign{text-align:center;user-select:none}
.bt-learning-text{min-width:0;padding-right:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-learning-added{background:color-mix(in srgb,var(--bt-green) 9%,transparent)}
.bt-learning-added .bt-learning-sign{color:var(--bt-green)}
.bt-learning-removed{background:color-mix(in srgb,var(--bt-danger) 7%,transparent)}
.bt-learning-removed .bt-learning-sign{color:var(--bt-danger)}
.bt-learning-removed .bt-learning-text{color:var(--bt-ink-2)}
.bt-learning-gap{height:1px;margin:6px 12px;background:var(--bt-q-rule)}
.bt-learning-morebar{display:flex;justify-content:center;padding:4px 0 8px}
.bt-learning-morebar-shut{position:relative;margin-top:-36px;padding-top:28px;background:linear-gradient(transparent,color-mix(in srgb,var(--bt-ink) 2.5%,var(--bt-card)) 60%)}
.bt-learning-more{height:24px;padding:0 10px;border:0;border-radius:999px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-q-edge);font:inherit;font-size:12px;color:var(--bt-ink-2);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-learning-more:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-learning-more:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-learning-why{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-learning-btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 16px;border:0;border-radius:999px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:background-color .12s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-learning-btn svg{width:15px;height:15px}
.bt-learning-decline{background:transparent;box-shadow:inset 0 0 0 1px var(--bt-line-2);color:var(--bt-ink)}
.bt-learning-decline:hover:not(:disabled){background:var(--bt-hover)}
.bt-learning-approve{padding-left:13px;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-learning-approve:hover:not(:disabled){opacity:.86}
.bt-learning-btn:disabled{opacity:.45;cursor:default}
.bt-learning-btn:active:not(:disabled){scale:.96}
.bt-learning-btn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.bt-learning-btn{transition:background-color .12s ease,opacity .12s ease}.bt-learning-btn:active:not(:disabled){scale:none}}
.bt-learning-error{font-size:12px;line-height:16px;color:var(--bt-danger)}
`
