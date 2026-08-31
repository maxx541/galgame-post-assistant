/** 取消一則還沒發的排程 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const items = await loadSchedule()
  const it = items.find(x => x.id === id)
  if (!it) throw createError({ statusCode: 404, message: '找不到這筆排程' })
  if (it.status !== 'pending') throw createError({ statusCode: 400, message: '這筆已經不是待發狀態了' })
  await updateSchedule(id, { status: 'cancelled', doneAt: new Date().toISOString() })
  logInfo('schedule', `取消排程 ${it.platform} ${it.at}`)
  return { ok: true }
})
