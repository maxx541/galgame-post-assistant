import { join } from 'node:path'

export default defineEventHandler(async () => {
  return await readJson<{ tags: string[] }>(join(dataDir(), 'tags.json'), { tags: [] })
})
