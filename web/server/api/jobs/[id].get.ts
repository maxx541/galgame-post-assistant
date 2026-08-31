/** 單一工作的進度。前端就是輪詢這支 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const j = await getJob(id)
  if (!j) throw createError({ statusCode: 404, message: '找不到這個工作（可能是伺服器重開過）' })
  return j
})
