/**
 * 本機排程器：時間到就把佇列裡的貼文發出去。
 *
 * IG 與 Threads 的 API 沒有排程可用（IG 的參數鎖在 Meta 白名單、Threads 根本沒有），
 * 所以那兩個平台只能靠這個。Facebook 想交給 Meta 的話走另一條路，跟這裡無關。
 *
 * 跟發掘的排程器一樣：每 30 秒檢查一次「有沒有到期的」，
 * 而不是為每一則設一個長計時器 —— 改時間或取消不用重啟就生效。
 */
const TICK_MS = 30_000

export default defineNitroPlugin(() => {
  const g = globalThis as { __publishTimer?: NodeJS.Timeout }
  // 熱重載會重複執行 plugin，先把舊的清掉
  if (g.__publishTimer) clearInterval(g.__publishTimer)

  let busy = false
  g.__publishTimer = setInterval(() => {
    if (busy) return
    busy = true
    void tick().finally(() => {
      busy = false
    })
  }, TICK_MS)

  logInfo('schedule', '發佈排程器已就緒（工具開著時才會發 IG／Threads）')
})

async function tick() {
  let items
  try {
    items = await loadSchedule()
  } catch {
    return
  }
  const { due, stale } = dueItems(items)
  if (!due.length && !stale.length) return

  for (const it of stale) {
    await updateSchedule(it.id, {
      status: 'error',
      error: '排定時間過了太久（超過 6 小時）都沒開著工具，就不補發了',
      doneAt: new Date().toISOString()
    })
    logWarn('schedule', `${it.platform} ${it.at} 過期未發：${it.postId}`)
  }

  for (const it of due) {
    try {
      logInfo('schedule', `時間到，發佈 ${it.platform}｜${it.postId}`)
      const r = await publishOne({
        postId: it.postId,
        variantId: it.variantId,
        platform: it.platform,
        fbMode: 'now',
        withComment: !!it.comment
      })
      await recordPublish(it.postId, it.variantId, r, { scheduledAt: it.at, comment: it.comment })
      await updateSchedule(it.id, {
        status: 'done',
        externalId: r.externalId,
        url: r.url,
        doneAt: new Date().toISOString()
      })
      logOk('schedule', `${it.platform} 排程發佈完成｜${r.externalId}`)
    } catch (e) {
      const msg = (e as { message?: string }).message || String(e)
      const attempts = it.attempts + 1
      // 規範沒過、字數超標這種再試幾次也一樣，直接判失敗
      const permanent = /規範|上限|一定要有圖|找不到/.test(msg)
      await updateSchedule(it.id, {
        attempts,
        error: msg,
        ...(permanent || attempts >= MAX_ATTEMPTS
          ? { status: 'error' as const, doneAt: new Date().toISOString() }
          : {})
      })
      logWarn('schedule', `${it.platform} 排程發佈失敗（第 ${attempts} 次）：${msg}`)
    }
  }
}
