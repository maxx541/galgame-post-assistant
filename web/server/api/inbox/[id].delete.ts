import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const dir = join(inboxDir(), id)
  if (await exists(dir)) await fs.rm(dir, { recursive: true, force: true })
  return { ok: true }
})
