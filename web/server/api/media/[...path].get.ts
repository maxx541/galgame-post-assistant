import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp'
}

/** /api/media/posts/<id>/<file> 或 /api/media/inbox/<id>/<file> */
export default defineEventHandler(async event => {
  const raw = getRouterParam(event, 'path') || ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.length !== 3) throw createError({ statusCode: 400, message: '路徑不正確' })
  const scope = parts[0] === 'inbox' ? 'inbox' : 'posts'
  const id = safeSegment(parts[1] as string)
  const file = safeSegment(parts[2] as string)
  const base = scope === 'inbox' ? inboxDir() : postsDir()
  const p = join(base, id, 'images', file)
  if (!(await exists(p))) throw createError({ statusCode: 404, message: '找不到圖片' })
  setHeader(event, 'content-type', MIME[extname(file).toLowerCase()] || 'application/octet-stream')
  setHeader(event, 'cache-control', 'no-cache')
  return await fs.readFile(p)
})
