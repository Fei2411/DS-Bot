import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'

// Sizes, types and the save step for the files a Bot's reply points at. The
// bytes come from the computer (`file-read`, a local file) or from the web (a
// link the reply names); either way the phone keeps a copy, then the user picks
// where it lands.
const MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4',
  mp3: 'audio/mpeg', epub: 'application/epub+zip',
}

export function mimeOfName(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

export function extLabel(name: string): string {
  return (name.split('.').pop() ?? '').toUpperCase().slice(0, 5)
}

export function sizeText(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FOLDER = 'dsbot-files'

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120)
  return cleaned === '' ? 'file' : cleaned
}

async function cacheUri(name: string): Promise<string> {
  const base = FileSystem.cacheDirectory
  if (base === null) throw new Error('This phone has no cache folder')
  const folder = `${base}${FOLDER}/`
  await FileSystem.makeDirectoryAsync(folder, { intermediates: true }).catch(() => {})
  const uri = `${folder}${safeName(name)}`
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  return uri
}

export async function cacheBase64(name: string, data: string): Promise<string> {
  const uri = await cacheUri(name)
  await FileSystem.writeAsStringAsync(uri, data, { encoding: FileSystem.EncodingType.Base64 })
  return uri
}

export async function cacheUrl(url: string, name: string): Promise<string> {
  const uri = await cacheUri(name)
  const result = await FileSystem.downloadAsync(url, uri)
  return result.uri
}

// Android asks for a folder once per save (Downloads is one tap) and the file
// lands there like any other file. iOS uses the share sheet's Save to Files.
export async function saveToDevice(uri: string, name: string, mime: string): Promise<'saved' | 'shared' | 'canceled'> {
  if (Platform.OS !== 'android') {
    if (!(await Sharing.isAvailableAsync())) throw new Error('Saving is not available on this phone')
    await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: name })
    return 'shared'
  }
  const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync()
  if (!permission.granted) return 'canceled'
  const target = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, safeName(name), mime)
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  await FileSystem.writeAsStringAsync(target, base64, { encoding: FileSystem.EncodingType.Base64 })
  return 'saved'
}

export async function shareFile(uri: string, name: string, mime: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone')
  await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: name })
}
