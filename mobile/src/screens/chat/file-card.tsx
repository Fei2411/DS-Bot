import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTeam } from '../../team/context.tsx'
import { cacheBase64, cacheUrl, extLabel, mimeOfName, saveToDevice, shareFile, sizeText } from '../../team/files.ts'
import { t } from '../../ui/i18n.ts'
import { DownloadIcon, FileIcon, ShareIcon } from '../../ui/icons.tsx'
import { radius, type as typeScale, useTheme } from '../../ui/tokens.ts'

// A file a Bot's reply points at: a local file on the computer (`file-read`
// sends it) or a web link the phone fetches itself. Download saves it through
// the system's folder picker; share hands it to another app. `readOnly` shows a
// file the user sent, with no actions.
export interface FileCardFile {
  name: string
  bytes?: number
  mime?: string
  path?: string
  url?: string
  attachmentId?: string
}

type Phase = 'idle' | 'downloading' | 'sharing' | 'saved'

export function FileCard({ file, onOpenText, readOnly = false }: { file: FileCardFile; onOpenText?: () => void; readOnly?: boolean }) {
  const { p } = useTheme()
  const { call, hello } = useTeam()
  const [phase, setPhase] = useState<Phase>('idle')
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const cached = useRef<string | null>(null)
  const mime = file.mime ?? mimeOfName(file.name)
  const downloadable = file.path !== undefined || file.url !== undefined
  const busy = phase === 'downloading' || phase === 'sharing'

  const prepare = async (): Promise<string> => {
    if (cached.current !== null) return cached.current
    if (file.url !== undefined) {
      cached.current = await cacheUrl(file.url, file.name)
      return cached.current
    }
    if (file.path === undefined) throw new Error(t('This file stays on the computer'))
    const limit = hello?.maxFileBytes
    if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && file.bytes !== undefined && file.bytes > limit) {
      throw Object.assign(new Error(t('This file is too large for the phone')), { code: 'bot/too-large' })
    }
    const answer = await call('file-read', { path: file.path }) as { data?: string; name?: string } | null
    const data = typeof answer?.data === 'string' ? answer.data : ''
    if (data === '') throw new Error(t('This file cannot be downloaded here'))
    cached.current = await cacheBase64(answer?.name ?? file.name, data)
    return cached.current
  }
  const reason = (failure: unknown): string => {
    const code = (failure as { code?: string })?.code ?? ''
    const message = (failure as { message?: string })?.message ?? ''
    if (code === 'bot/not-found' && /unknown endpoint/i.test(message)) return t('Update DS Bot on the computer to download files')
    if (code === 'bot/not-found') return t('The file is not on the computer anymore')
    if (code === 'bot/too-large') return t('This file is too large for the phone')
    return message !== '' ? message : t('The download failed')
  }
  const run = async (task: () => Promise<void>) => {
    setNote(null)
    setFailed(false)
    try {
      await task()
    } catch (failure) {
      setFailed(true)
      setNote(reason(failure))
      setPhase('idle')
    }
  }
  const download = () => { if (!busy) return run(async () => {
    setPhase('downloading')
    const uri = await prepare()
    const outcome = await saveToDevice(uri, file.name, mime)
    setPhase(outcome === 'canceled' ? 'idle' : 'saved')
    if (outcome === 'saved') setNote(t('Saved'))
  }) }
  const share = () => { if (!busy) return run(async () => {
    setPhase('sharing')
    const uri = await prepare()
    await shareFile(uri, file.name, mime)
    setPhase('idle')
  }) }

  return (
    <View style={{ marginTop: 6 }}>
      <View style={[styles.card, { borderColor: p.line2, backgroundColor: p.card }]}>
        <View style={[styles.badge, { backgroundColor: p.hover }]}>
          <FileIcon size={17} color={p.ink2} />
          <Text style={[styles.ext, { color: p.ink3 }]} numberOfLines={1}>{extLabel(file.name)}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[typeScale.small, { color: p.ink, fontWeight: '500' }]} numberOfLines={1}>{file.name}</Text>
          <Text style={[typeScale.caption, { color: p.ink3, marginTop: 1 }]} numberOfLines={1}>
            {[sizeText(file.bytes), readOnly ? mime : phase === 'saved' ? t('Saved') : ''].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {readOnly ? null : downloadable ? (
          <>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Download')} disabled={busy} onPress={download} hitSlop={6} style={styles.action}>
              {phase === 'downloading' ? <ActivityIndicator size="small" color={p.ink2} /> : <DownloadIcon size={18} color={phase === 'saved' ? p.accent : p.ink2} />}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Share')} disabled={busy} onPress={share} hitSlop={6} style={styles.action}>
              {phase === 'sharing' ? <ActivityIndicator size="small" color={p.ink2} /> : <ShareIcon size={18} color={p.ink2} />}
            </Pressable>
          </>
        ) : (
          <Pressable accessibilityRole="button" onPress={onOpenText} hitSlop={6} style={styles.action}>
            <Text style={[typeScale.caption, { color: p.accent, fontWeight: '600' }]}>{t('Open')}</Text>
          </Pressable>
        )}
      </View>
      {note !== null ? <Text style={[typeScale.caption, { color: failed ? p.danger : p.ink3, marginTop: 4 }]}>{note}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth },
  badge: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 1 },
  ext: { fontSize: 8, lineHeight: 10, fontWeight: '700', letterSpacing: 0.3 },
  action: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
})
