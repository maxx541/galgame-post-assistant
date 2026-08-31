import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const file = safeSegment(getRouterParam(event, 'file') || '')
  const m = await loadMaterial(id)
  if (!m) throw createError({ statusCode: 404, message: '找不到這則素材' })
  const p = join(inboxDir(), id, 'images', file)
  if (await exists(p)) await fs.rm(p)
  m.images = m.images.filter(f => f !== file)
  await saveMaterial(m)
  return m
})
