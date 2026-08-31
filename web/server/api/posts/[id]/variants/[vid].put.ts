import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const vid = safeSegment(getRouterParam(event, 'vid') || '')
  const dir = join(postsDir(), id, 'variants')
  if (!(await exists(join(postsDir(), id)))) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const body = await readBody<Partial<Variant>>(event)
  const file = join(dir, vid + '.md')
  let current: Variant = { id: vid, label: '版本', platform: 'facebook', locked: false, body: '' }
  if (await exists(file)) current = parseVariant(await fs.readFile(file, 'utf8'), vid)
  const next: Variant = {
    id: vid,
    label: body.label ?? current.label,
    platform: body.platform ?? current.platform,
    locked: body.locked ?? current.locked,
    body: body.body ?? current.body
  }
  await ensureDir(dir)
  await fs.writeFile(file, serializeVariant(next), 'utf8')
  const meta = await loadPost(id)
  if (meta) await savePostMeta(meta)
  return next
})
