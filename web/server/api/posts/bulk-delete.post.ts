/**
 * 批量刪除貼文。整個資料夾連圖片一起刪，對應的素材改回未撰寫、待發排程取消。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ ids?: string[] }>(event)
  const targets = (body?.ids || []).map(x => safeSegment(String(x))).filter(Boolean)
  if (!targets.length) throw createError({ statusCode: 400, message: '沒有指定要刪除的貼文' })

  let deleted = 0
  let bytes = 0
  const failed: { id: string; message: string }[] = []
  for (const id of targets) {
    try {
      const b = await deletePost(id)
      if (b < 0) continue
      bytes += b
      deleted++
    } catch (e) {
      failed.push({ id, message: (e as Error).message })
    }
  }

  logOk('post', `批量刪除貼文 ${deleted} 則，釋出 ${(bytes / 1048576).toFixed(1)}MB`)
  return { deleted, bytes, failed, requested: targets.length }
})
