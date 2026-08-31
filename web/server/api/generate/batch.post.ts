/**
 * 批次撰寫。每則之間留緩衝，避免短時間連打模型端點。
 *
 * 緩衝以前是在前端用 setTimeout 倒數，而且整個迴圈跑在頁面元件裡 ——
 * 使用者從「素材夾」切到別頁，元件就被卸載，進度全沒了、接也接不回來。
 * 搬到伺服器上之後，換頁、重新整理、甚至關掉分頁都不影響。
 */
const GAP_SECONDS = 20

export default defineEventHandler(async event => {
  const body = await readBody<{ materialIds?: string[]; perPlatform?: number }>(event)
  const ids = (body?.materialIds || []).map(x => safeSegment(String(x))).filter(Boolean)
  if (!ids.length) throw createError({ statusCode: 400, message: '沒有指定要撰寫的素材' })
  const perPlatform = Math.min(Math.max(Number(body?.perPlatform) || 1, 1), 3)

  const running = await activeJob('write')
  if (running) {
    throw createError({ statusCode: 409, message: '已經有一批在撰寫中了，等它跑完或先停止' })
  }

  const job = startJob(
    'write',
    `撰寫 ${ids.length} 則`,
    async ctx => {
      ctx.setTotal(ids.length)
      const ok: string[] = []
      const fails: { id: string; message: string }[] = []

      for (let i = 0; i < ids.length; i++) {
        if (ctx.shouldStop()) {
          ctx.note('已停止，剩下的沒有寫')
          break
        }
        const id = ids[i]!
        const m = await loadMaterial(id)
        const name = m?.title || id
        ctx.note(`撰寫中：${name}`)
        try {
          const r = await $fetch<{ postId: string; created: number }>('/api/generate', {
            method: 'POST',
            body: { materialId: id, perPlatform }
          })
          ok.push(r.postId)
          ctx.step(`寫好「${name}」${r.created} 個版本`)
        } catch (e) {
          const msg = errText(e)
          fails.push({ id, message: msg })
          ctx.step(`「${name}」失敗：${msg}`, false)
        }

        // 最後一則後面不用等
        if (i < ids.length - 1 && !ctx.shouldStop()) {
          ctx.note(`緩衝 ${GAP_SECONDS} 秒…`)
          await ctx.sleep(GAP_SECONDS * 1000)
        }
      }
      return { postIds: ok, failed: fails }
    },
    { total: ids.length }
  )

  return { jobId: job.id, total: ids.length }
})

/** $fetch 丟出來的訊息藏在 data.message，直接 String() 會拿到沒用的字 */
function errText(e: unknown): string {
  const x = e as { data?: { message?: string }; message?: string }
  return x?.data?.message || x?.message || String(e)
}
