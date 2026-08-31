export default defineEventHandler(async () => {
  const n = await loadNotionSettings()
  // 不回傳 token 本身
  return {
    enabled: n.enabled,
    titleFilter: n.titleFilter,
    maxPages: n.maxPages,
    autoRun: n.autoRun,
    intervalHours: n.intervalHours,
    lastRunAt: n.lastRunAt,
    hasToken: !!n.token
  }
})
