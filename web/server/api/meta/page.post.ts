/** 選定要發佈的專頁，把它的 Page Token 存起來 */
export default defineEventHandler(async event => {
  const body = await readBody<{ pageId?: string }>(event)
  const pageId = (body?.pageId || '').trim()
  if (!pageId) throw createError({ statusCode: 400, message: '要指定專頁' })

  const m = await loadMeta()
  if (!m.userToken) throw createError({ statusCode: 400, message: '還沒完成連接，先填 App ID / Secret / Token' })

  // 先從 /me/accounts 找；找不到就直接跟該粉專要 Page Token（系統用戶常走這條）
  let page: PageInfo | undefined
  try {
    page = (await listPages(m.userToken, m.graphVersion)).find(p => p.id === pageId)
  } catch {
    /* 列不出來就走下面的直取 */
  }
  if (!page) page = await fetchPageToken(pageId, m.userToken, m.graphVersion)

  const next = await saveMeta({
    pageId: page.id,
    pageName: page.name,
    pageToken: page.access_token,
    tokenCheckedAt: new Date().toISOString()
  })
  logOk('meta', `已連接專頁「${page.name}」`)
  return { connected: true, pageId: next.pageId, pageName: next.pageName }
})
