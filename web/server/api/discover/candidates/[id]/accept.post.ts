/** 把候選收進素材夾。走既有的 saveMaterial，跟手動建立的素材完全一樣 */
export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const items = await loadCandidates()
  const c = findCandidate(items, id)
  if (!c) throw createError({ statusCode: 404, message: '找不到這則候選' })
  if (c.status === 'accepted' && c.materialId) {
    return { alreadyDone: true, materialId: c.materialId, candidate: c }
  }

  const materialId = await candidateToMaterial(c)
  c.status = 'accepted'
  c.materialId = materialId
  await saveCandidates(items)
  logOk('discover', `手動收錄 @${c.handle}（${c.score} 分）→ ${materialId}`)
  return { materialId, candidate: c }
})
