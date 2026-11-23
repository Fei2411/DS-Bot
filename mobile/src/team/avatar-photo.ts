import type { Action } from 'expo-image-manipulator'
import { t } from '../ui/i18n.ts'

type Photo = { uri: string; width: number; height: number }
type RenderJpeg = (uri: string, actions: Action[]) => Promise<{ base64?: string | null }>

// Always re-encode: a native picker can return HEIC or another format the host
// cannot store, and the original photo may be larger than an avatar permits.
export async function avatarPhoto(asset: Photo, renderJpeg: RenderJpeg): Promise<string> {
  const crop = Math.min(asset.width, asset.height)
  const photo = await renderJpeg(asset.uri, [
    { crop: { originX: (asset.width - crop) / 2, originY: (asset.height - crop) / 2, width: crop, height: crop } },
    { resize: { width: 160, height: 160 } },
  ])
  if (!photo.base64) throw new Error(t('That image is too large'))
  const image = `data:image/jpeg;base64,${photo.base64}`
  if (image.length > 160000) throw new Error(t('That image is too large'))
  return image
}
