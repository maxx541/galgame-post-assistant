import { join } from 'node:path'

export default defineEventHandler(async event => {
  const body = await readBody<{ tags?: string[] }>(event)
  const tags = [...new Set((body?.tags || []).map(t => t.trim()).filter(t => t.startsWith('#')))]
  await writeJson(join(dataDir(), 'tags.json'), { tags })
  return { tags }
})
