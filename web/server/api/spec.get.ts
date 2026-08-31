import { promises as fs } from 'node:fs'

export default defineEventHandler(async () => {
  const p = await ensureSpec()
  const content = await fs.readFile(p, 'utf8').catch(() => '')
  return { ok: true, content, empty: !content.trim(), path: p }
})
