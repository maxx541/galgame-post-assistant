import { join } from 'node:path'

/** 存 Base URL／金鑰／模型；金鑰留空表示不更動，送 __clear__ 表示清除 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    baseUrl?: string
    apiKey?: string
    model?: string
    sendImages?: boolean
  }>(event)

  const p = join(dataDir(), 'settings.json')
  const cur = await readJson<Record<string, unknown>>(p, {})

  if (typeof body?.baseUrl === 'string') cur.baseUrl = body.baseUrl.trim() || DEFAULT_BASE_URL
  if (typeof body?.model === 'string') cur.model = body.model.trim() || DEFAULT_MODEL
  if (typeof body?.sendImages === 'boolean') cur.sendImages = body.sendImages
  if (typeof body?.apiKey === 'string') {
    const k = body.apiKey.trim()
    if (k === '__clear__') delete cur.apiKey
    else if (k) cur.apiKey = k
  }

  await writeJson(p, cur)
  const s = await loadSettings()
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    sendImages: s.sendImages,
    hasKey: !!s.apiKey,
    source: s.source,
    endpoint: endpointFor(s.baseUrl, 'chat/completions')
  }
})
