/** 開一個有頭的 Chromium 讓使用者登入 X，登入狀態存進 data/.browser/x 供之後重用 */
export default defineEventHandler(async () => {
  const d = await xLogin()
  if (!d.loggedIn) {
    throw createError({ statusCode: 400, message: d.message || '沒有偵測到登入' })
  }
  return { loggedIn: true, profile: (d as { profile?: string }).profile || '' }
})
