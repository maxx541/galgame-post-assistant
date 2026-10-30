export default defineEventHandler(async event => {
  const body = await readBody<{ url?: string }>(event)
  const url = (body?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw createError({ statusCode: 400, message: '請提供 http(s) 網址' })

  // X／Facebook／Instagram 走 Playwright + 已登入的瀏覽器 profile，一般 fetch 會被擋
  if (isXUrl(url) || isSocialUrl(url)) {
    try {
      return isXUrl(url) ? toScrapeResult(await xScrape(url)) : toScrapeResultSocial(await socialScrape(url))
    } catch (e) {
      const why = (e as { message?: string }).message || String(e)
      try {
        const r = await scrapeUrl(url)
        return {
          ...r,
          via: 'fetch' as const,
          warning: ['Playwright 讀取失敗，已退回一般抓取。', why, r.warning].filter(Boolean).join(' ')
        }
      } catch {
        throw createError({ statusCode: 502, message: why })
      }
    }
  }

  try {
    return { ...(await scrapeUrl(url)), via: 'fetch' as const }
  } catch (e) {
    throw createError({ statusCode: 502, message: '抓取失敗：' + (e as Error).message })
  }
})
