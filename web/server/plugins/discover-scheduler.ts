/**
 * 發掘的排程器。**推特抓取與 Notion 日報是兩條獨立的線**，各有自己的
 * 開關、間隔與上次執行時間 —— 日報幾秒就跑完，沒理由陪著 X 那條一小時的線等。
 *
 * 刻意做成「每 5 分鐘檢查一次該不該跑」而不是「設一個 intervalHours 的計時器」，
 * 這樣在設定頁改間隔或開關，不用重啟就會生效。
 *
 * 兩邊的 autoRun 預設都是關的 —— 自動連外這種事要使用者明確打開才做。
 */

/** 多久檢查一次該不該跑 */
const CHECK_MS = 5 * 60 * 1000
/** 啟動後先等一下再檢查，避免跟開機時的其他事情擠在一起 */
const FIRST_CHECK_MS = 90 * 1000

/** 到期了嗎 */
function isDue(lastAt: string, intervalHours: number, now = Date.now()) {
  const last = Date.parse(lastAt || '')
  if (!Number.isFinite(last)) return true
  return now >= last + Math.max(0.25, intervalHours) * 3600_000
}

async function tickX() {
  let s
  try {
    s = await loadDiscoverSettings()
  } catch {
    return
  }
  if (!s.autoRun) return
  if (!s.sources.some(x => x.enabled && x.handle)) return
  if (!isDue(s.lastRunAt, s.intervalHours)) return
  // 已經有一輪在跑就不要疊上去
  if (await activeJob('discover')) return

  logInfo('discover', `推特抓取排程觸發（間隔 ${s.intervalHours} 小時）`)
  const targets = s.sources.filter(x => x.enabled && x.handle)
  startJob('discover', `抓取 ${targets.length} 個 X 帳號（排程）`, ctx => runX(undefined, ctx), {
    total: targets.length
  })
}

async function tickNotion() {
  let n
  try {
    n = await loadNotionSettings()
  } catch {
    return
  }
  if (!n.autoRun || !n.enabled || !n.token) return
  if (!isDue(n.lastRunAt, n.intervalHours)) return
  if (await activeJob('notion')) return

  logInfo('discover', `Notion 日報排程觸發（間隔 ${n.intervalHours} 小時）`)
  startJob('notion', '讀取 Notion 日報（排程）', async ctx => {
    const r = await runNotion(ctx)
    await saveNotionSettings({ lastRunAt: new Date().toISOString() })
    return r
  }, { total: 1 })
}

async function tick() {
  await tickX()
  await tickNotion()
}

export default defineNitroPlugin(() => {
  // 開發模式熱重載會重複掛載，用全域旗標擋掉重複的計時器
  const g = globalThis as unknown as { __discoverTimer?: ReturnType<typeof setInterval> }
  if (g.__discoverTimer) return

  setTimeout(() => {
    void tick()
    g.__discoverTimer = setInterval(() => void tick(), CHECK_MS)
  }, FIRST_CHECK_MS)

  logInfo('discover', '排程器已就緒（推特與日報各自獨立，預設都不自動執行）')
})
