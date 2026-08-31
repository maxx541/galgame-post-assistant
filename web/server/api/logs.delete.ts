export default defineEventHandler(async () => {
  clearLogs()
  logInfo('system', '記錄已清空')
  return { ok: true }
})
