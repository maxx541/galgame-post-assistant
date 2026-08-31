import { promises as fs } from 'node:fs'

export default defineEventHandler(async () => {
  const p = specPath()
  if (!(await exists(p))) return { ok: false, content: '找不到 文案撰寫規範.md', path: p }
  return { ok: true, content: await fs.readFile(p, 'utf8'), path: p }
})
