/**
 * 定期清理的排程器。跟其他排程器一樣，每小時檢查一次「該不該跑」，
 * 而不是設一個一週的長計時器 —— 工具不是一直開著，改設定也不用重啟。
 *
 * 關機錯過了就在下次開著時補跑，清理晚一點跑沒有壞處。
 */
const CHECK_MS = 60 * 60 * 1000
/** 啟動後先等一下，不要跟開機時的其他事情擠在一起 */
const FIRST_CHECK_MS = 3 * 60 * 1000

async function tick() {
  try {
    const s = await loadCleanupSettings()
    if (!cleanupIsDue(s)) return
    await runCleanup('schedule')
  } catch (e) {
    logWarn('cleanup', `定期清理失敗：${(e as Error).message}`)
  }
}

export default defineNitroPlugin(() => {
  const g = globalThis as unknown as { __cleanupTimer?: ReturnType<typeof setInterval> }
  if (g.__cleanupTimer) return

  setTimeout(() => {
    void tick()
    g.__cleanupTimer = setInterval(() => void tick(), CHECK_MS)
  }, FIRST_CHECK_MS)
})
