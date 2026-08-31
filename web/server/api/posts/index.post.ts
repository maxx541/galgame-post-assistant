import { join } from 'node:path'

export default defineEventHandler(async event => {
  const body = await readBody<{ title?: string; category?: string; postType?: string; platforms?: string[] }>(event)
  const title = (body?.title || '').trim() || '未命名貼文'
  const base = todayStamp() + '-' + slugify(title)
  await ensureDir(postsDir())
  const id = await uniqueId(postsDir(), base)
  const meta = emptyMeta(id, title)
  if (body?.category) meta.category = body.category
  if (body?.postType) meta.postType = body.postType
  if (body?.platforms?.length) meta.platforms = body.platforms
  await ensureDir(join(postsDir(), id, 'variants'))
  await ensureDir(join(postsDir(), id, 'images'))
  await savePostMeta(meta)
  return { ...meta, variants: [] }
})
