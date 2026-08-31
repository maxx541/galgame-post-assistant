/** 忽略一則候選：標記起來，留在「已忽略」清單裡，不直接刪 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const items = await loadCandidates()
  const c = findCandidate(items, id)
  if (!c) throw createError({ statusCode: 404, message: '找不到這則候選' })
  c.status = 'ignored'
  await saveCandidates(items)
  return { candidate: c }
})
