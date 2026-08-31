/** 測 Threads 的 token。Threads 走自己的網域與 OAuth，跟 Page Token 無關 */
export default defineEventHandler(async () => {
  const m = await loadMeta()
  const r = await testThreads(m)
  await saveMeta({
    threadsUsername: r.username,
    ...(r.id && !m.threadsUserId ? { threadsUserId: r.id } : {})
  })
  logOk('meta', `Threads 連線正常｜@${r.username}`)
  return r
})
