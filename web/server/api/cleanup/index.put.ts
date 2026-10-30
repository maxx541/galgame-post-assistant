/** 存清理設定。天數一律夾在合理範圍，避免填 0 把剛做好的東西刪掉 */
export default defineEventHandler(async event => {
  const body = await readBody<Partial<CleanupSettings>>(event)
  const days = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const cur = await loadCleanupSettings()
  const patch: Partial<CleanupSettings> = {}
  if (typeof body?.enabled === 'boolean') {
    patch.enabled = body.enabled
    // 剛打開時從現在起算一週，不要一存檔就馬上刪
    if (body.enabled && !cur.enabled) patch.lastRunAt = new Date().toISOString()
  }
  if (body?.intervalDays !== undefined) patch.intervalDays = days(body.intervalDays, 1, 90, cur.intervalDays)
  if (body?.posts) {
    patch.posts = {
      enabled: typeof body.posts.enabled === 'boolean' ? body.posts.enabled : cur.posts.enabled,
      keepDays: days(body.posts.keepDays ?? cur.posts.keepDays, 1, 3650, cur.posts.keepDays),
      onlyPublished: typeof body.posts.onlyPublished === 'boolean' ? body.posts.onlyPublished : cur.posts.onlyPublished
    }
  }
  if (body?.inbox) {
    patch.inbox = {
      enabled: typeof body.inbox.enabled === 'boolean' ? body.inbox.enabled : cur.inbox.enabled,
      keepDays: days(body.inbox.keepDays ?? cur.inbox.keepDays, 1, 3650, cur.inbox.keepDays),
      onlyWritten: typeof body.inbox.onlyWritten === 'boolean' ? body.inbox.onlyWritten : cur.inbox.onlyWritten
    }
  }
  return await saveCleanupSettings(patch)
})
