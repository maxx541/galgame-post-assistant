/** 測 IG 帳號讀不讀得到 */
export default defineEventHandler(async () => {
  const m = await loadMeta()
  const r = await testInstagram(m)
  if (r.username) await saveMeta({ igUsername: r.username })
  logOk('meta', `Instagram 連線正常｜@${r.username}`)
  return r
})
