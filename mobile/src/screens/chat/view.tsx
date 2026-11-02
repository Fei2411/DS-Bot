import { useMemo, useRef, useState } from 'react'
import { Linking, Modal, PanResponder, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg'
import { compileFormula, createScope, evaluate, isFormula, choiceValue, show } from 'deep-view/core'
import { t } from '../../ui/i18n.ts'
import { radius, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Markdown } from './markdown.tsx'
import { useTeam } from '../../team/context.tsx'

const type = typeScale
const SERIES = ['accent', 'green', 'magenta', 'violet', 'cyan', 'star']

// A node value is either literal or `{ '=': 'formula' }` resolved against the
// view's inputs and `let`s. A formula that fails under the current values shows
// a placeholder only where it sits, like the desktop's errored cell.
export function ViewCard({ sessionId, view, p, readOnly, bare }: { sessionId: string; view: { id?: string; title?: string; children?: unknown[]; blueprint?: { id?: string; title?: string; children?: unknown[] } }; p: Palette; readOnly?: boolean; bare?: boolean }) {
  const blueprint = view.blueprint ?? view
  const [inputs, setInputs] = useState<Map<string, unknown>>(() => collectInputs(blueprint))
  const [lets] = useState<Map<string, unknown>>(() => collectLets(blueprint))
  const [done, setDone] = useState<string | null>(null)
  const { call } = useTeam()
  const lookup = useMemo(() => createScope(inputs, lets), [inputs, lets])
  const val = (v: unknown) => {
    if (!isFormula(v)) return v
    const compiled = compileFormula(String((v as Record<string, unknown>)['=']))
    if ('error' in compiled) return undefined
    try {
      const out = evaluate(compiled.tree, lookup)
      return 'error' in out ? undefined : out.value
    } catch { return undefined }
  }
  const answer = (id: string, action: string, values: unknown) => {
    if (readOnly || done !== null) return
    call('view-reply', { sessionId, viewId: view.id ?? blueprint.id, action, values })
      .then(() => { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setDone(id) })
      .catch(() => {})
  }
  const dismiss = () => void call('dismiss-view', { sessionId }).catch(() => {})
  const nodes = blueprint.children ?? []
  return (
    <View style={bare === true ? null : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {bare !== true && blueprint.title !== undefined ? <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{blueprint.title}</Text> : null}
      {nodes.map((node, index) => <Node key={index} node={node} val={val} p={p}
        readOnly={readOnly === true || done !== null} inputs={inputs} setInputs={setInputs} answer={answer} done={done} />)}
      {done === null && readOnly !== true ? <Pressable accessibilityRole="button" onPress={dismiss} style={styles.dismiss}><Text style={[type.caption, { color: p.ink3 }]}>{t('Dismiss')}</Text></Pressable> : null}
      {done !== null ? <Text style={[type.caption, { color: p.green, marginTop: 4 }]}>{t('Done')}</Text> : null}
    </View>
  )
}

// Inputs seed the formula scope with their declared values.
function collectInputs(blueprint: unknown, into = new Map<string, unknown>()): Map<string, unknown> {
  for (const node of walk(blueprint)) {
    if (node?.id !== undefined && ['slider', 'number', 'choice', 'toggle'].includes(String(node.type))) into.set(String(node.id), node.value)
  }
  return into
}
function collectLets(blueprint: unknown, into = new Map<string, unknown>()): Map<string, unknown> {
  for (const node of walk(blueprint)) {
    if (node?.let !== undefined) for (const [k, v] of Object.entries(node.let as Record<string, unknown>)) {
      const compiled = compileFormula(String((v as Record<string, unknown>)['='] ?? v))
      if (!('error' in compiled)) into.set(k, compiled.tree)
    }
  }
  return into
}
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  const rec = node as Record<string, unknown>
  yield rec
  if (Array.isArray(rec.children)) for (const child of rec.children) yield* walk(child)
  if (Array.isArray(rec.options)) for (const opt of rec.options) yield* walk(opt)
}

function Node({ node, val, p, readOnly, inputs, setInputs, answer, done }: {
  node: unknown; val: (v: unknown) => unknown; p: Palette; readOnly: boolean
  inputs: Map<string, unknown>; setInputs: (fn: (m: Map<string, unknown>) => Map<string, unknown>) => void
  answer: (id: string, action: string, values: unknown) => void; done: string | null
}) {
  if (node === null || typeof node !== 'object') return null
  const n = node as Record<string, unknown>
  const kids = () => (Array.isArray(n.children) ? n.children.map((c, i) => <Node key={i} node={c} val={val} p={p} readOnly={readOnly} inputs={inputs} setInputs={setInputs} answer={answer} done={done} />) : null)
  switch (n.type) {
    case 'stack': return <View style={{ gap: 10 }}>{kids()}</View>
    case 'row': return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{kids()}</View>
    case 'text': {
      const text = val(n.text)
      return text === undefined ? <Placeholder p={p} /> : <Markdown text={String(text)} p={p} textColor={n.tone === 'muted' ? p.ink2 : p.ink} />
    }
    case 'metric': {
      const value = val(n.value)
      return value === undefined ? <Placeholder p={p} /> : (
        <View>
          <Text style={[type.caption, { color: p.ink3 }]}>{String(val(n.label) ?? '')}</Text>
          <Text style={[type.largeTitle, { color: p.ink }]}>{show(value)}</Text>
          {n.caption !== undefined ? <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.caption) ?? '')}</Text> : null}
        </View>
      )
    }
    case 'table': {
      const columns = val(n.columns), rows = val(n.rows)
      if (!Array.isArray(columns) || !Array.isArray(rows)) return <Placeholder p={p} />
      return <DataTable columns={columns.map(String)} rows={rows as unknown[][]} p={p} />
    }
    case 'chart': {
      const categories = val(n.categories), series = val(n.series)
      if (!Array.isArray(categories) || !Array.isArray(series)) return <Placeholder p={p} />
      return <Chart kind={String(val(n.kind) ?? 'bar')} categories={categories.map(String)} series={series as { name?: string; values?: unknown[]; data?: unknown[] }[]} unit={String(val(n.unit) ?? '')} p={p} />
    }
    case 'progress': {
      const percent = val(n.percent)
      const pct = percent !== undefined ? Number(percent) : Number(val(n.value) ?? 0) / Math.max(1, Number(val(n.max) ?? 1)) * 100
      return (
        <View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.label) ?? '')}</Text>
            <Text style={[type.caption, { color: p.ink3 }]}>{n.valueLabel !== undefined ? String(val(n.valueLabel)) : `${Math.round(pct)}%`}</Text>
          </View>
          <View style={[styles.track, { backgroundColor: p.hover }]}>
            <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', borderRadius: 3, backgroundColor: p.accent }} />
          </View>
        </View>
      )
    }
    case 'callout': {
      const tones: Record<string, string> = { info: p.accent, good: p.green, warn: p.star, bad: p.danger }
      const c = tones[String(n.tone ?? 'info')] ?? p.accent
      return <View style={[styles.callout, { backgroundColor: p.hover, borderLeftColor: c }]}><Markdown text={String(val(n.text) ?? '')} p={p} textColor={p.ink} /></View>
    }
    case 'sources': {
      const items = val(n.items)
      if (!Array.isArray(items)) return <Placeholder p={p} />
      return (
        <View style={{ gap: 4 }}>
          {items.map((item: Record<string, unknown>, i: number) => {
            const href = String(item?.url ?? '')
            if (!/^https?:/i.test(href)) return null
            return <Text key={i} style={[type.caption, { color: p.accent }]} onPress={() => void Linking.openURL(href).catch(() => {})}>{String(item?.title ?? href)}</Text>
          })}
        </View>
      )
    }
    case 'html':
      return (
        <View style={{ gap: 4 }}>
          {n.summary !== undefined ? <Markdown text={String(val(n.summary) ?? '')} p={p} textColor={p.ink2} /> : null}
          <Text style={[type.caption, { color: p.ink3 }]}>{t('Open it on the computer')}</Text>
        </View>
      )
    case 'slider': {
      const id = String(n.id)
      const min = Number(n.min ?? 0), max = Number(n.max ?? 100), step = Number(n.step ?? 1)
      const value = Number(inputs.get(id) ?? n.value ?? min)
      const snap = (v: number) => Math.min(max, Math.max(min, Math.round((min + (v / 100) * (max - min)) / step) * step))
      const set = (v: number) => { if (!readOnly) setInputs(prev => new Map(prev).set(id, snap(v))) }
      return (
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.label) ?? '')}</Text>
            <Text style={[type.caption, { color: p.ink }]}>{value}{n.unit !== undefined ? ` ${String(val(n.unit) ?? '')}` : ''}</Text>
          </View>
          <SliderTrack p={p} percent={(value - min) / Math.max(1e-9, max - min) * 100} disabled={readOnly} onPercent={set} />
        </View>
      )
    }
    case 'number': {
      const id = String(n.id)
      const min = n.min !== undefined ? Number(n.min) : -Infinity, max = n.max !== undefined ? Number(n.max) : Infinity
      const step = Number(n.step ?? 1), value = Number(inputs.get(id) ?? n.value ?? 0)
      const bump = (d: number) => { if (!readOnly) setInputs(prev => new Map(prev).set(id, Math.min(max, Math.max(min, value + d * step)))) }
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.label) ?? '')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => bump(-1)} style={[styles.stepper, { borderColor: p.line }]}><Text style={{ color: p.ink, fontSize: 16 }}>−</Text></Pressable>
            <Text style={[type.settingsRow, { color: p.ink, minWidth: 36, textAlign: 'center' }]}>{value}{n.unit !== undefined ? ` ${String(val(n.unit) ?? '')}` : ''}</Text>
            <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => bump(1)} style={[styles.stepper, { borderColor: p.line }]}><Text style={{ color: p.ink, fontSize: 16 }}>+</Text></Pressable>
          </View>
        </View>
      )
    }
    case 'choice': {
      const id = String(n.id), options = Array.isArray(n.options) ? n.options : []
      const current = inputs.get(id) ?? n.value
      const short = options.every(o => String(choiceValue(o)).length <= 12)
      const pick = (v: unknown) => { if (!readOnly) setInputs(prev => new Map(prev).set(id, v)) }
      return (
        <View style={{ gap: 4 }}>
          {n.label !== undefined ? <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.label) ?? '')}</Text> : null}
          <View style={short && options.length <= 4 ? styles.segment : { gap: 4 }}>
            {options.map((o, i) => {
              const v = choiceValue(o), on = String(v) === String(current)
              return (
                <Pressable key={i} accessibilityRole="button" disabled={readOnly} onPress={() => pick(v)}
                  style={[short && options.length <= 4 ? { flex: 1 } : null, styles.segmentRow, { borderColor: on ? p.accent : p.line, backgroundColor: on ? p.hover : 'transparent' }]}>
                  <Text style={[type.caption, { color: on ? p.accent : p.ink2, textAlign: 'center' }]}>{String(v)}</Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      )
    }
    case 'toggle': {
      const id = String(n.id), on = Boolean(inputs.get(id) ?? n.value)
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[type.caption, { color: p.ink2 }]}>{String(val(n.label) ?? '')}</Text>
          <Switch value={on} disabled={readOnly} onValueChange={v => setInputs(prev => new Map(prev).set(id, v))} trackColor={{ true: p.accent }} />
        </View>
      )
    }
    case 'options':
      return <OptionsNode n={n} p={p} readOnly={readOnly} answer={answer} />
    case 'confirm': {
      const id = String(n.id)
      return (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => answer(id, 'confirm', { confirmed: false })} style={[styles.choice, { backgroundColor: p.hover }]}><Text style={[type.settingsRow, { color: p.ink2, textAlign: 'center' }]}>{String(val(n.cancelLabel) ?? t('Cancel'))}</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => answer(id, 'confirm', { confirmed: true })} style={[styles.choice, { backgroundColor: p.accent }]}><Text style={[type.settingsRow, { color: p.accentInk, textAlign: 'center' }]}>{String(val(n.confirmLabel) ?? t('Confirm'))}</Text></Pressable>
        </View>
      )
    }
    case 'form':
      return <FormNode n={n} val={val} p={p} readOnly={readOnly} answer={answer} />
    case 'submit':
      return <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => answer(String(n.id), 'submit', Object.fromEntries(inputs))} style={[styles.submit, { backgroundColor: p.accent, marginTop: 4 }]}><Text style={[type.settingsRow, { color: p.accentInk, textAlign: 'center' }]}>{String(val(n.label) ?? t('Submit'))}</Text></Pressable>
    default: return null
  }
}

function OptionsNode({ n, p, readOnly, answer }: { n: Record<string, unknown>; p: Palette; readOnly: boolean; answer: (id: string, action: string, values: unknown) => void }) {
  const id = String(n.id), options = Array.isArray(n.options) ? n.options : [], multi = n.multi === true
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const toggle = (v: string) => setPicked(prev => { const s = new Set(prev); s.has(v) ? s.delete(v) : (multi ? s.add(v) : (s.clear(), s.add(v))); return s })
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {options.map((o, i) => {
        const v = String(choiceValue(o)), on = picked.has(v)
        return (
          <Pressable key={i} accessibilityRole="button" disabled={readOnly} onPress={() => multi ? toggle(v) : answer(id, 'options', { selected: [v] })}
            style={[styles.optionRow, { borderColor: on ? p.accent : p.line, backgroundColor: on ? p.hover : 'transparent' }]}>
            <Text style={[type.settingsRow, { color: p.ink }]}>{v}</Text>
          </Pressable>
        )
      })}
      {multi ? <Pressable accessibilityRole="button" disabled={readOnly || picked.size === 0} onPress={() => answer(id, 'options', { selected: [...picked] })} style={[styles.submit, { backgroundColor: picked.size === 0 ? p.hover : p.accent }]}><Text style={[type.settingsRow, { color: picked.size === 0 ? p.ink3 : p.accentInk, textAlign: 'center' }]}>{t('Submit')}</Text></Pressable> : null}
    </View>
  )
}

function FormNode({ n, val, p, readOnly, answer }: { n: Record<string, unknown>; val: (v: unknown) => unknown; p: Palette; readOnly: boolean; answer: (id: string, action: string, values: unknown) => void }) {
  const id = String(n.id), fields = Array.isArray(n.fields) ? n.fields : []
  const [values, setValues] = useState<Record<string, string>>({})
  return (
    <View style={{ gap: 8, marginTop: 4 }}>
      {fields.map((f: Record<string, unknown>, i: number) => (
        <TextInput key={i} editable={!readOnly} placeholder={String(f?.label ?? '')} placeholderTextColor={p.ink3} multiline={f?.kind === 'multiline'}
          value={values[String(f?.id ?? i)] ?? ''} onChangeText={v => setValues(prev => ({ ...prev, [String(f?.id ?? i)]: v }))}
          style={[styles.field, { color: p.ink, backgroundColor: p.hover }]} />
      ))}
      <Pressable accessibilityRole="button" disabled={readOnly} onPress={() => answer(id, 'form', { values })} style={[styles.submit, { backgroundColor: p.accent }]}>
        <Text style={[type.settingsRow, { color: p.accentInk, textAlign: 'center' }]}>{String(val(n.submitLabel) ?? t('Submit'))}</Text>
      </Pressable>
    </View>
  )
}

function Placeholder({ p }: { p: Palette }) {
  return <Text style={[type.caption, { color: p.ink3, fontStyle: 'italic' }]}>…</Text>
}

// A draggable bar, implemented directly on PanResponder — no new dependency.
function SliderTrack({ p, percent, disabled, onPercent }: { p: Palette; percent: number; disabled: boolean; onPercent: (v: number) => void }) {
  const width = useRef(1)
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: () => !disabled,
    onPanResponderGrant: e => onPercent(e.nativeEvent.locationX / width.current * 100),
    onPanResponderMove: e => onPercent(e.nativeEvent.locationX / width.current * 100),
  })).current
  return (
    <View style={{ paddingVertical: 8 }} {...responder.panHandlers} onLayout={e => { width.current = e.nativeEvent.layout.width }}>
      <View style={[styles.track, { backgroundColor: p.hover }]}>
        <View style={{ width: `${percent}%`, height: '100%', borderRadius: 3, backgroundColor: p.accent }} />
      </View>
      <View style={[styles.knob, { backgroundColor: p.accent, left: `${Math.min(100, Math.max(0, percent))}%` }]} />
    </View>
  )
}

// bar/hbar/line/area/donut, theme-colored, first series on the accent. A tap on a
// category shows its values and dims the rest; a legend tap hides the series;
// the "…" menu swaps to a table or copies the data as CSV.
function Chart({ kind, categories, series, unit, p }: { kind: string; categories: string[]; series: { name?: string; values?: unknown[]; data?: unknown[] }[]; unit: string; p: Palette }) {
  const [pinned, setPinned] = useState(-1)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [menu, setMenu] = useState(false)
  const [asTable, setAsTable] = useState(false)
  const rows = series.map((s, si) => ({ name: String(s?.name ?? `${si + 1}`), values: (s?.values ?? s?.data ?? []).map(Number), color: (p as unknown as Record<string, string>)[SERIES[si % SERIES.length]] ?? p.accent }))
  const visible = rows.filter((_, si) => !hidden.has(si))
  const max = Math.max(1, ...visible.flatMap(s => s.values))
  const W = 280, H = 160, pad = 6
  const pick = (i: number) => setPinned(prev => prev === i ? -1 : i)
  if (asTable) return (
    <View>
      <DataTable columns={['', ...rows.map(s => s.name)]} rows={categories.map((c, i) => [c, ...rows.map(s => s.values[i] !== undefined ? `${s.values[i]}${unit}` : '—')])} p={p} />
      <Text style={[type.caption, { color: p.accent }]} onPress={() => setAsTable(false)}>{t('View as chart')}</Text>
    </View>
  )
  const bw = Math.max(6, (W - pad * 2) / Math.max(1, categories.length) - 6)
  return (
    <View>
      <View style={{ position: 'relative', height: H }}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        {kind === 'donut' ? <Donut rows={visible} pinned={pinned} p={p} /> :
         kind === 'line' || kind === 'area' ? visible.map((s, si) => {
          const pts = s.values.map((v, i) => `${pad + (i + 0.5) * (W - 2 * pad) / categories.length},${H - pad - (v / max) * (H - 2 * pad)}`)
          return <Polygon key={si} points={pts.join(' ')} fill={kind === 'area' ? s.color : 'none'} fillOpacity={kind === 'area' ? 0.25 : 0} stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        }) :
         visible.map((s, si) => s.values.map((v, i) => {
          const h = (v / max) * (H - 2 * pad)
          const x = pad + i * ((W - 2 * pad) / categories.length) + si * (bw / Math.max(1, visible.length))
          const y = kind === 'hbar' ? pad + i * ((H - 2 * pad) / categories.length) + si * (bw / Math.max(1, visible.length)) : H - pad - h
          return kind === 'hbar'
            ? <Rect key={`${si}-${i}`} x={pad} y={y} width={(v / max) * (W - 2 * pad)} height={bw / visible.length - 2} rx={2} fill={s.color} opacity={pinned === -1 || pinned === i ? 1 : 0.25} onPress={() => pick(i)} />
            : <Rect key={`${si}-${i}`} x={x} y={y} width={bw / visible.length - 2} height={h} rx={2} fill={s.color} opacity={pinned === -1 || pinned === i ? 1 : 0.25} onPress={() => pick(i)} />
        }))}
        </Svg>
        <View style={styles.chartTouch} pointerEvents="box-none">
          {categories.map((_, i) => <Pressable key={i} style={{ flex: 1 }} onPress={() => pick(i)} />)}
        </View>
      </View>
      {pinned >= 0 ? <Text style={[type.caption, { color: p.ink }]}>{categories[pinned]}: {visible.map(s => `${s.name} ${s.values[pinned] ?? '—'}${unit}`).join(' · ')}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4, alignItems: 'center' }}>
        {rows.map((s, si) => (
          <Pressable key={si} onPress={() => setHidden(prev => { const h = new Set(prev); h.has(si) ? h.delete(si) : h.add(si); return h })} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, opacity: hidden.has(si) ? 0.35 : 1 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
            <Text style={[type.caption, { color: p.ink2 }]}>{s.name}</Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" onPress={() => setMenu(true)} style={{ marginLeft: 'auto', padding: 4 }}><Text style={{ color: p.ink3, fontSize: 18 }}>…</Text></Pressable>
      </View>
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }} onPress={() => setMenu(false)}>
          <View style={{ backgroundColor: p.card, borderRadius: 12, borderWidth: 1, borderColor: p.line, minWidth: 180 }}>
            <Pressable onPress={() => { setAsTable(true); setMenu(false) }} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: p.hover }]}><Text style={[type.settingsRow, { color: p.ink }]}>{t('View as table')}</Text></Pressable>
            <Pressable onPress={() => { void Clipboard.setStringAsync([['', ...rows.map(s => s.name)].join(','), ...categories.map((c, i) => [c, ...rows.map(s => s.values[i] ?? '')].join(','))].join('\n')); setMenu(false) }} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: p.hover }]}><Text style={[type.settingsRow, { color: p.ink }]}>{t('Copy data (CSV)')}</Text></Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

function Donut({ rows, pinned, p }: { rows: { name: string; values: number[]; color: string }[]; pinned: number; p: Palette }) {
  const total = Math.max(1e-9, rows.reduce((sum, s) => sum + (s.values[0] ?? 0), 0))
  let at = -90
  return (
    <>
      {rows.map((s, i) => {
        const frac = (s.values[0] ?? 0) / total
        const large = frac > 0.5 ? 1 : 0
        const x1 = 140 + 60 * Math.cos(at * Math.PI / 180), y1 = 80 + 60 * Math.sin(at * Math.PI / 180)
        at += frac * 360
        const x2 = 140 + 60 * Math.cos(at * Math.PI / 180), y2 = 80 + 60 * Math.sin(at * Math.PI / 180)
        return <Path key={i} d={`M140 80 L${x1} ${y1} A60 60 0 ${large} 1 ${x2} ${y2} Z`} fill={s.color} opacity={pinned === -1 || pinned === i ? 1 : 0.25} />
      })}
      <Circle cx={140} cy={80} r={32} fill={p.card} />
    </>
  )
}

function DataTable({ columns, rows, p }: { columns: string[]; rows: unknown[][]; p: Palette }) {
  return (
    <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.item }}>
      <View style={{ flexDirection: 'row', backgroundColor: p.hover }}>
        {columns.map((c, i) => <Text key={i} style={[type.caption, { color: p.ink2, minWidth: 72, padding: 6 }]}>{c}</Text>)}
      </View>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', borderTopWidth: ri === 0 ? 0 : 1, borderTopColor: p.line }}>
          {columns.map((_, ci) => <Text key={ci} style={[type.caption, { color: p.ink, minWidth: 72, padding: 6 }]}>{String(row[ci] ?? '')}</Text>)}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, borderWidth: 1, padding: 14, gap: 10, marginVertical: 4 },
  track: { height: 6, borderRadius: 3 },
  knob: { position: 'absolute', top: 4, width: 14, height: 14, borderRadius: 7, marginLeft: -7 },
  callout: { borderLeftWidth: 3, borderRadius: radius.item, padding: 8 },
  segment: { flexDirection: 'row', gap: 4 },
  segmentRow: { borderWidth: 1, borderRadius: radius.input, paddingVertical: 7, paddingHorizontal: 10 },
  optionRow: { borderWidth: 1, borderRadius: radius.option, paddingVertical: 10, paddingHorizontal: 12 },
  submit: { borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 16 },
  choice: { flex: 1, borderRadius: radius.pill, paddingVertical: 10 },
  field: { borderRadius: radius.input, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  stepper: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  menuRow: { paddingVertical: 12, paddingHorizontal: 16 },
  chartTouch: { position: 'absolute', top: 0, left: 0, right: 0, height: '100%', flexDirection: 'row' },
  dismiss: { alignSelf: 'center', paddingVertical: 4 },
})
