export default defineEventHandler(async event => {
  const q = getQuery(event)
  const status = String(q.status || '')
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300)
  const all = await loadCandidates()
  const items = (status ? all.filter(c => c.status === status) : all).slice(0, limit)
  return { items, total: all.length }
})
