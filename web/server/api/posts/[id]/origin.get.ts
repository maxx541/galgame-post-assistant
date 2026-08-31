import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'

/** 讀這則貼文每個版本的 AI 原稿，前端用來判斷有沒有被改過 */
export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const dir = join(postsDir(), id, 'origin')
  const out: Record<string, string> = {}
  if (!(await exists(dir))) return out
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.md')) continue
    out[basename(f, '.md')] = await fs.readFile(join(dir, f), 'utf8')
  }
  return out
})
