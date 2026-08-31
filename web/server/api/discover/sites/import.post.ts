/** 匯入網站清單。一行一個，第一欄網址、第二欄名字 */
export default defineEventHandler(async event => {
  const body = await readBody<{ text?: string; mode?: string }>(event)
  const text = String(body?.text || '')
  if (!text.trim()) throw createError({ statusCode: 400, message: '沒有內容可以匯入' })

  const parsed = parseSiteList(text)
  if (!parsed.length) {
    throw createError({ statusCode: 400, message: '解析不出任何網站。每行第一欄要是網址。' })
  }

  const cur = await loadDiscoverSettings()
  let sites = parsed
  let added = parsed.length
  let updated = 0
  if (body?.mode !== 'replace') {
    const m = mergeSites(cur.sites, parsed)
    sites = m.sites
    added = m.added
    updated = m.updated
  }

  const next = await saveDiscoverSettings({ sites })
  logOk('discover', `匯入網站：解析 ${parsed.length} 個、新增 ${added}、共 ${next.sites.length} 個`)
  return { parsed: parsed.length, added, updated, total: next.sites.length, sites: next.sites }
})
