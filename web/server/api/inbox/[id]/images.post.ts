import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 素材補圖：multipart 上傳（拖曳／Ctrl+V），或 { urls: [] } 從網址下載 */
export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const m = await loadMaterial(id)
  if (!m) throw createError({ statusCode: 404, message: '找不到這則素材' })
  const imgDir = join(inboxDir(), id, 'images')
  await ensureDir(imgDir)

  const added: string[] = []
  const failed: { url: string; reason: string }[] = []
  const type = getHeader(event, 'content-type') || ''

  if (type.includes('multipart/form-data')) {
    for (const part of (await readMultipartFormData(event)) || []) {
      if (!part.filename || !part.data?.length) continue
      const name = await nextImageName(imgDir, extFromType(part.type || '', part.filename))
      await fs.writeFile(join(imgDir, name), part.data)
      added.push(name)
    }
  } else {
    const body = await readBody<{ urls?: string[] }>(event)
    for (const url of body?.urls || []) {
      try {
        added.push(await downloadImage(url, imgDir, m.finalUrl || m.url))
      } catch (e) {
        failed.push({ url, reason: (e as Error).message })
      }
    }
    const twimg = failed.filter(f => isTwimg(f.url)).map(f => f.url)
    if (twimg.length) {
      try {
        const r = await downloadViaX(twimg, imgDir)
        added.push(...r.added)
      } catch {
        /* 保留原本的失敗訊息 */
      }
    }
  }

  m.images = [...m.images, ...added]
  await saveMaterial(m)
  return { added, failed, material: m }
})
