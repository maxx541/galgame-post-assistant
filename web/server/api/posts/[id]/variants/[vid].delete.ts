import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const vid = safeSegment(getRouterParam(event, 'vid') || '')
  const file = join(postsDir(), id, 'variants', vid + '.md')
  if (await exists(file)) await fs.rm(file)
  return { ok: true }
})
