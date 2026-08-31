/** 測一個網站讀不讀得到 RSS，順便回幾筆看看內容對不對 */
export default defineEventHandler(async event => {
  const body = await readBody<{ url?: string }>(event)
  const url = String(body?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw createError({ statusCode: 400, message: '要給 http(s) 網址' })

  const r = await fetchSiteFeed({ url, name: '', enabled: true }, 5)
  return {
    feedUrl: r.feedUrl,
    count: r.items.length,
    items: r.items.slice(0, 5).map(x => ({
      title: x.title,
      postedAt: x.postedAt,
      hasImage: !!x.image
    }))
  }
})
