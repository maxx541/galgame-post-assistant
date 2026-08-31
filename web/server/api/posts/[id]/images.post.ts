import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 支援兩種來源：multipart 上傳（拖曳／Ctrl+V），或 JSON { urls: [] } 從網址下載 */
export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const dir = join(postsDir(), id, 'images')
  await ensureDir(dir)

  const added: string[] = []
  const failed: { url: string; reason: string }[] = []
  const type = getHeader(event, 'content-type') || ''

  if (type.includes('multipart/form-data')) {
    const parts = (await readMultipartFormData(event)) || []
    for (const part of parts) {
      if (!part.filename || !part.data?.length) continue
      const ext = extFromType(part.type || '', part.filename)
      const name = await nextImageName(dir, ext)
      await fs.writeFile(join(dir, name), part.data)
      added.push(name)
    }
  } else {
    const body = await readBody<{ urls?: string[]; referer?: string }>(event)
    for (const url of body?.urls || []) {
      try {
        const name = await downloadImage(url, dir, body?.referer || '')
        added.push(name)
        post.images.push({ file: name, artist: '', alt: '', sourceUrl: url, selected: true })
      } catch (e) {
        failed.push({ url, reason: (e as Error).message })
      }
    }

    // 推特的圖直連失敗時，改用已登入的瀏覽器 context 再試一次
    const twimg = failed.filter(f => isTwimg(f.url)).map(f => f.url)
    if (twimg.length) {
      try {
        const r = await downloadViaX(twimg, dir)
        for (let i = 0; i < r.added.length; i++) {
          const name = r.added[i] as string
          added.push(name)
          post.images.push({ file: name, artist: '', alt: '', sourceUrl: twimg[i] || '', selected: true })
        }
        const stillBad = new Set(r.failed.map(f => f.url))
        for (let i = failed.length - 1; i >= 0; i--) {
          const f = failed[i]!
          if (twimg.includes(f.url) && !stillBad.has(f.url)) failed.splice(i, 1)
        }
      } catch {
        /* 保留原本的失敗訊息 */
      }
    }
  }

  for (const name of added) {
    if (!post.images.some(i => i.file === name)) {
      post.images.push({ file: name, artist: '', alt: '', sourceUrl: '', selected: true })
    }
  }
  const { variants, ...meta } = post
  await savePostMeta(meta)
  return { added, failed, post: await loadPost(id) }
})
