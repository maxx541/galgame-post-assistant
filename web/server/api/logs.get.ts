export default defineEventHandler(async event => {
  const q = getQuery(event)
  const since = Number(q.since) || 0
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 400)
  return { entries: readLogs(since, limit), lastId: lastId() }
})
