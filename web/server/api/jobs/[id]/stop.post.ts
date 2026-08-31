/** 請求停止。長迴圈每圈會檢查一次，所以不會馬上停 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  if (!stopJob(id)) throw createError({ statusCode: 400, message: '這個工作不在執行中' })
  return { ok: true }
})
