/** 目前的背景工作。kind 可以只看某一類 */
export default defineEventHandler(async event => {
  const kind = String(getQuery(event).kind || '')
  return { items: await listJobs(kind || undefined) }
})
