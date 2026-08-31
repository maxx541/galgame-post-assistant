/**
 * 連接 Facebook。兩種 token 都吃：
 *   - 企業平台的「系統用戶 Token」：永久有效，直接用（推薦）
 *   - 一般 User Token：會自動換成長期（約 60 天）
 * 換不換，看 debug_token 回報的到期時間決定，不會硬換。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    appId?: string
    appSecret?: string
    userToken?: string
    graphVersion?: string
    /** 系統用戶沒把粉專掛在 /me/accounts 底下時，可以直接指定 */
    pageId?: string
  }>(event)

  const appId = (body?.appId || '').trim()
  const appSecret = (body?.appSecret || '').trim()
  const inputToken = (body?.userToken || '').trim()
  const graphVersion = (body?.graphVersion || '').trim() || DEFAULT_GRAPH_VERSION
  if (!appId || !appSecret || !inputToken) {
    throw createError({ statusCode: 400, message: 'App ID、App Secret、Token 三個都要填' })
  }

  logInfo('meta', '連接 Facebook：檢查 token')
  let info = await inspectToken(inputToken, appId, appSecret, graphVersion)
  if (!info.valid) {
    throw createError({ statusCode: 401, message: 'Token 無效。確認它是這個 App 產生的，而且沒有被撤銷。' })
  }

  let userToken = inputToken
  let tokenKind = info.neverExpires ? 'system' : 'user'
  if (needsExchange(info)) {
    logInfo('meta', 'token 快到期，換成長期')
    userToken = await exchangeLongLivedToken(appId, appSecret, inputToken, graphVersion)
    info = await inspectToken(userToken, appId, appSecret, graphVersion)
    tokenKind = info.neverExpires ? 'system' : 'user'
  }

  const missing = missingScopes(info.scopes)
  await saveMeta({ appId, appSecret, userToken, tokenKind, graphVersion })

  // 先試 /me/accounts；系統用戶有時候不會在這裡列出粉專，那就讓使用者直接填 Page ID
  let pages: PageInfo[] = []
  let listError = ''
  try {
    pages = await listPages(userToken, graphVersion)
  } catch (e) {
    listError = (e as { message?: string }).message || String(e)
  }

  // 有直接指定粉專就順便驗一下拿不拿得到 Page Token
  if (!pages.length && body?.pageId?.trim()) {
    pages = [await fetchPageToken(body.pageId.trim(), userToken, graphVersion)]
  }

  logOk(
    'meta',
    `token ${tokenKind === 'system' ? '永久（系統用戶）' : '長期'}｜找到 ${pages.length} 個專頁` +
      (missing.length ? `｜缺權限：${missing.join('、')}` : '')
  )

  return {
    pages: pages.map(p => ({ id: p.id, name: p.name, category: p.category || '' })),
    scopes: info.scopes,
    missing,
    tokenKind,
    tokenDesc: describeToken(info),
    listError
  }
})
