import * as Sharing from 'expo-sharing'
import { t } from '../ui/i18n.ts'

export async function shareFile(saved: { uri: string; name: string; mime: string }): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('Saving to the device is not available on this phone'))
  await Sharing.shareAsync(saved.uri, { mimeType: saved.mime, dialogTitle: saved.name })
}
