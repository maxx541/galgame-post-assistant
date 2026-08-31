import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const dir = join(postsDir(), id)
  if (!(await exists(dir))) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  await fs.rm(dir, { recursive: true, force: true })
  return { ok: true }
})
