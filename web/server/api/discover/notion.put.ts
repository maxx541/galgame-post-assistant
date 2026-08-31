export default defineEventHandler(async event => {
  const body = await readBody<{ token?: string; enabled?: boolean; titleFilter?: string; maxPages?: number; autoRun?: boolean; intervalHours?: number }>(event)
  const patch: Record<string, unknown> = {}
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body?.titleFilter === 'string') patch.titleFilter = body.titleFilter.trim()
  if (Number.isFinite(body?.maxPages)) patch.maxPages = Math.min(Math.max(Number(body!.maxPages), 1), 14)
  if (typeof body?.autoRun === 'boolean') patch.autoRun = body.autoRun
  if (Number.isFinite(body?.intervalHours)) {
    patch.intervalHours = Math.min(Math.max(Number(body!.intervalHours), 1), 48)
  }
  if (typeof body?.token === 'string') {
    const t = body.token.trim()
    if (t === '__clear__') patch.token = ''
    else if (t) patch.token = t
  }
  const n = await saveNotionSettings(patch)
  logInfo('discover', `Notion 設定已更新（${n.enabled ? '啟用' : '停用'}、最多 ${n.maxPages} 頁）`)
  return {
    enabled: n.enabled, titleFilter: n.titleFilter, maxPages: n.maxPages,
    autoRun: n.autoRun, intervalHours: n.intervalHours, lastRunAt: n.lastRunAt,
    hasToken: !!n.token
  }
})
