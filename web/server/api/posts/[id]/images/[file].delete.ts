import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const file = safeSegment(getRouterParam(event, 'file') || '')
  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const p = join(postsDir(), id, 'images', file)
  if (await exists(p)) await fs.rm(p)
  post.images = post.images.filter(i => i.file !== file)
  const { variants, ...meta } = post
  await savePostMeta(meta)
  return await loadPost(id)
})
