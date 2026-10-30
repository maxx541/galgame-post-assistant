/** 開一個有頭的 Chromium 讓使用者登入 Facebook 或 Instagram，登入狀態存進 data/.browser/meta 供之後重用 */
export default defineEventHandler(async event => {
  const body = await readBody<{ site?: string }>(event)
  const site = body?.site === 'ig' ? 'ig' : body?.site === 'fb' ? 'fb' : null
  if (!site) throw createError({ statusCode: 400, message: '要指定 site：fb 或 ig' })

  const d = await socialLogin(site)
  if (!d.ok) {
    throw createError({ statusCode: 400, message: d.message || `沒有偵測到登入 ${SOCIAL_NAME[site]}` })
  }
  return { loggedIn: d.loggedIn, profile: d.profile }
})
