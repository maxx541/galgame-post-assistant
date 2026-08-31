/** 刪掉一則候選。去重靠 seen.json，刪了也不會下輪又冒出來 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const items = await loadCandidates()
  const c = findCandidate(items, id)
  if (!c) throw createError({ statusCode: 404, message: '找不到這則候選' })
  await saveCandidates(items.filter(x => x !== c))
  return { ok: true }
})
