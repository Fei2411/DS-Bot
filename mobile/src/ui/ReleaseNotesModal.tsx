import { useEffect, useMemo } from 'react'
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  cleanSemver,
  getReleaseEntry,
  RELEASE_NOTES,
  selectReleaseNotes,
} from '../../../ds-bot/src/shared/release-notes.js'
import { currentAppVersion } from '../team/app-version.ts'
import { closeMobileReleaseNotes, useMobileReleaseNotes, type MobileReleaseNotesEntry } from '../team/release-notes.ts'
import { getLang, t } from './i18n.ts'
import { radius, shadow, type, useTheme } from './tokens.ts'

const RELEASES_URL = 'https://github.com/Fei-Craft/DS-Bot/releases'

function activeLocale(): string {
  const pref = getLang()
  if (pref === 'zh' || pref === 'en') return pref
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

export function ReleaseNotesModal({
  releases = RELEASE_NOTES as MobileReleaseNotesEntry[],
  host = 'all',
}: {
  releases?: MobileReleaseNotesEntry[]
  host?: 'auto' | 'manual' | 'all'
} = {}) {
  const { p } = useTheme()
  const modal = useMobileReleaseNotes()
  const locale = activeLocale()
  const current = cleanSemver(modal.current ?? currentAppVersion())
  const ownsModal = host === 'all' || modal.mode === host

  // Clear a manual modal if its hosting screen unmounts while open (e.g. closing the Settings sheet).
  useEffect(() => () => {
    if (host === 'manual') closeMobileReleaseNotes('manual')
  }, [host])

  const entry = useMemo(
    () => (current ? (getReleaseEntry(current, releases) as MobileReleaseNotesEntry | null) : null),
    [current, releases],
  )
  const block = useMemo(
    () => (entry ? (selectReleaseNotes(entry, locale) as { intro?: string; items: string[]; outro?: string } | null) : null),
    [entry, locale],
  )

  if (!modal.open || !ownsModal) return null

  const titleText = current
    ? t("What's new in v{version}", { version: current })
    : t('Release notes')
  const subtitle = entry?.date || ''

  return (
    <Modal
      visible={modal.open}
      transparent
      animationType="fade"
      onRequestClose={() => closeMobileReleaseNotes()}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => closeMobileReleaseNotes()}
        />
        <View style={[styles.card, { backgroundColor: p.main, borderColor: p.line2 }, shadow(4)]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[type.headerTitle, { color: p.ink }]}>{titleText}</Text>
              {subtitle ? <Text style={[type.caption, { color: p.ink3, marginTop: 2 }]}>{subtitle}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('Close')}
              onPress={() => closeMobileReleaseNotes()}
              style={({ pressed }) => [styles.closeBtn, pressed && { backgroundColor: p.hover }]}
            >
              <Text style={{ fontSize: 18, color: p.ink2 }}>×</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {entry && block ? (
              <View style={styles.section}>
                {block.intro ? <Text style={[styles.intro, { color: p.ink2 }]}>{block.intro}</Text> : null}
                <View style={styles.list}>
                  {block.items.map((item, idx) => (
                    <View key={`${entry.version}-${idx}`} style={styles.item}>
                      <View style={[styles.dot, { backgroundColor: p.accent }]} />
                      <Text style={[styles.itemText, { color: p.ink }]}>{item}</Text>
                    </View>
                  ))}
                </View>
                {block.outro ? <Text style={[type.caption, { color: p.ink3 }]}>{block.outro}</Text> : null}
              </View>
            ) : (
              <Text style={[type.small, { color: p.ink2 }]}>{t('No release notes for this version yet.')}</Text>
            )}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: p.line }]}>
            <Pressable onPress={() => void Linking.openURL(RELEASES_URL)} style={styles.linkBtn}>
              <Text style={[type.caption, { color: p.ink2 }]}>{t('Full changelog')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => closeMobileReleaseNotes()}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Got it')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '82%',
    borderRadius: radius.dialog,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flexGrow: 0,
  },
  bodyContent: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 14,
  },
  section: {
    gap: 8,
  },
  intro: {
    fontSize: 13,
    lineHeight: 20,
  },
  list: {
    gap: 10,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 8,
  },
  itemText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 22,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  linkBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  primaryBtn: {
    height: 36,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
