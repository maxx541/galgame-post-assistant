/**
 * 匯入追蹤帳號清單。吃 CSV／TSV／純一行一個，帳號欄可以是 handle、@handle 或整串網址。
 * mode = merge（預設，同名保留原設定）｜replace（整份換掉）
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ text?: string; mode?: string }>(event)
  const text = String(body?.text || '')
  if (!text.trim()) throw createError({ statusCode: 400, message: '沒有內容可以匯入' })

  const parsed = parseHandleList(text)
  if (!parsed.length) {
    throw createError({
      statusCode: 400,
      message: '解析不出任何帳號。每行第一欄要是帳號名、@帳號或推特網址（英數與底線、最長 15 字）。'
    })
  }

  const cur = await loadDiscoverSettings()
  let sources = parsed
  let added = parsed.length
  let updated = 0
  if (body?.mode !== 'replace') {
    const m = mergeSources(cur.sources, parsed)
    sources = m.sources
    added = m.added
    updated = m.updated
  }

  const next = await saveDiscoverSettings({ sources })
  logOk('discover', `匯入追蹤帳號：解析 ${parsed.length} 個、新增 ${added}、共 ${next.sources.length} 個`)
  return { parsed: parsed.length, added, updated, total: next.sources.length, sources: next.sources }
})
