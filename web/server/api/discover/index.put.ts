/** 存追蹤帳號、關鍵字、門檻、權重等設定 */
export default defineEventHandler(async event => {
  const body = await readBody<Record<string, unknown>>(event)
  delete body.lastRunAt
  const next = await saveDiscoverSettings(body as Partial<DiscoverSettings>)
  logInfo('discover', `設定已更新：${next.sources.filter(s => s.enabled).length} 個啟用帳號、門檻 ${next.threshold}`)
  return next
})
