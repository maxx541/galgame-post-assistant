/** 從已連接的專頁自動找出綁在上面的 IG 商業帳號 */
export default defineEventHandler(async () => {
  const m = await loadMeta()
  const r = await detectInstagram(m)
  await saveMeta(r)
  logOk('meta', `偵測到 Instagram 帳號 @${r.igUsername}（${r.igUserId}）`)
  return r
})
