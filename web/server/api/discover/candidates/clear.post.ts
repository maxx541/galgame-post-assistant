/**
 * 一次清掉候選。
 *
 * forget：要不要同時把「已讀」紀錄一起清掉。
 *   false（預設）→ 清單乾淨，但下次抓取不會把同樣的東西再放回來
 *   true          → 當作沒看過，下次抓取／重讀會重新收進來
 *
 * 為什麼要這個開關：去重是靠 seen.json 記的 id，跟候選池是兩回事。
 * 只清候選池的話，使用者清完再讀一次日報會發現「什麼都沒跑出來」——
 * 因為那 35 則全被當成處理過跳掉了。
 *
 * status: pending 只清待處理 / ignored 只清已忽略 / done 清掉已收錄與已忽略 / all 全部
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ status?: string; forget?: boolean }>(event).catch(
    () => ({}) as { status?: string; forget?: boolean }
  )
  const status = String(body?.status || 'pending')

  const items = await loadCandidates()
  const before = items.length
  const removed: Candidate[] = []
  const keep = items.filter(c => {
    const drop = status === 'all' ? true : status === 'done' ? c.status !== 'pending' : c.status === status
    if (drop) removed.push(c)
    return !drop
  })

  await saveCandidates(keep)

  let forgotten = 0
  if (body?.forget) {
    // 已經變成素材的那些不能忘 —— 忘了下輪又會重新收一次，變成重複素材
    const gone = new Set(removed.filter(c => c.status !== 'accepted').map(c => c.id))
    const seen = await loadSeen()
    const next = seen.filter(id => !gone.has(id))
    forgotten = seen.length - next.length
    await saveSeen(next)
  }

  logOk(
    'discover',
    `清掉 ${before - keep.length} 則候選（${status}）` +
      (forgotten ? `，並忘記 ${forgotten} 筆已讀紀錄` : '') +
      `，剩 ${keep.length} 則`
  )
  return { removed: before - keep.length, remaining: keep.length, forgotten }
})
