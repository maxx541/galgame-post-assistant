import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp'
}

/**
 * /api/media/posts/<id>/<file> 或 /api/media/inbox/<id>/<file>
 * 加 ?w=240 之類的就回縮圖（列表用），不加就是原圖。
 */
export default defineEventHandler(async event => {
  const raw = getRouterParam(event, 'path') || ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.length !== 3) throw createError({ statusCode: 400, message: '路徑不正確' })
  const scope = parts[0] === 'inbox' ? 'inbox' : 'posts'
  const id = safeSegment(parts[1] as string)
  const file = safeSegment(parts[2] as string)
  const base = scope === 'inbox' ? inboxDir() : postsDir()
  const src = join(base, id, 'images', file)
  if (!(await exists(src))) throw createError({ statusCode: 404, message: '找不到圖片' })

  let p = src
  let type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  // 不用 getQuery：資料夾名常有 #（推文的 hashtag），路徑解碼後 ?w= 會被當成 #後面的錨點吃掉
  const w = Number(/[?&]w=(\d+)/.exec(event.path)?.[1])
  if (Number.isFinite(w) && w > 0) {
    const t = await ensureThumb(src, pickThumbWidth(w))
    if (t) {
      p = t
      type = 'image/webp'
    }
  }

  // 圖可能被換掉但檔名不變，所以不能長快取；改用 ETag，沒變就回 304 不用重傳
  const st = await fs.stat(p)
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  setHeader(event, 'cache-control', 'no-cache')
  setHeader(event, 'etag', etag)
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }
  setHeader(event, 'content-type', type)
  return await fs.readFile(p)
})
