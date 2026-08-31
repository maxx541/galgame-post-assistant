import { join } from 'node:path'

/** 中斷連接，把金鑰與 token 清掉 */
export default defineEventHandler(async () => {
  const p = join(dataDir(), 'settings.json')
  const all = await readJson<Record<string, unknown>>(p, {})
  delete all.meta
  await writeJson(p, all)
  logInfo('meta', 'Facebook 連接已中斷')
  return { ok: true }
})
