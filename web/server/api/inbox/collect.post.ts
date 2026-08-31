import { join } from 'node:path'

/**
 * 一次貼多個連結，逐一抓取後放進素材夾。
 *
 * 這支只負責「開一個背景工作」馬上回 jobId —— 抓取本身在伺服器上跑完。
 * 以前是同步跑完才回應，使用者一切換視窗，瀏覽器把分頁降級就斷在半路。
 *
 * 抓失敗的也會建立素材（帶 warning），讓你可以手動補內容或貼圖，而不是整批消失。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ urls?: string[]; text?: string; platforms?: string[] }>(event)
  const urls = (body?.urls?.length ? body.urls : extractUrls(body?.text || '')).slice(0, 20)
  if (!urls.length) throw createError({ statusCode: 400, message: '沒有找到任何 http(s) 網址' })

  const platforms = body?.platforms?.length ? body.platforms : ['facebook']

  const job = startJob(
    'collect',
    `抓取 ${urls.length} 個連結`,
    async ctx => {
      ctx.setTotal(urls.length)
      const results: CollectResult[] = []
      for (const url of urls) {
        if (ctx.shouldStop()) {
          ctx.note('已停止，剩下的沒有抓')
          break
        }
        const r = await collectUrl(url, platforms)
        results.push(r)
        ctx.step(r.ok ? `抓到「${r.title || r.id}」` : `失敗：${r.message}`, r.ok)
      }
      return {
        results,
        added: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length
      }
    },
    { total: urls.length }
  )

  return { jobId: job.id, total: urls.length }
})

interface CollectResult {
  url: string
  id?: string
  title?: string
  ok: boolean
  message?: string
}

/** 抓一個連結。丟不出例外 —— 失敗也要留下一則空素材讓使用者自己補 */
async function collectUrl(url: string, platforms: string[]): Promise<CollectResult> {
  try {
    logInfo('material', `抓取 ${url}`)
    let sc: Record<string, unknown>
    if (isXUrl(url)) {
      try {
        sc = toScrapeResult(await xScrape(url)) as unknown as Record<string, unknown>
      } catch (e) {
        const r = await scrapeUrl(url)
        sc = {
          ...r,
          via: 'fetch',
          text: r.description,
          warning: ['Playwright 讀取失敗，已退回一般抓取。', (e as Error).message, r.warning]
            .filter(Boolean)
            .join(' ')
        }
      }
    } else {
      const r = await scrapeUrl(url)
      sc = { ...r, via: 'fetch', text: r.description }
    }

    const title = String(sc.title || '')
    const text = String(sc.text || sc.description || '')
    await ensureDir(inboxDir())
    const id = await uniqueId(inboxDir(), materialSlugBase(title, text, url))
    const imgDir = join(inboxDir(), id, 'images')
    await ensureDir(imgDir)

    const m = emptyMaterial(id, url)
    m.title = title
    m.finalUrl = String(sc.finalUrl || url)
    m.text = text
    m.author = String(sc.author || '')
    m.handle = String(sc.handle || '')
    m.postedAt = String(sc.createdAt || '')
    m.sourceGuess = String(sc.sourceGuess || '')
    m.via = String(sc.via || 'fetch')
    m.platforms = platforms
    m.warning = String(sc.warning || '')

    // 導流連結：推文取內文裡的外連（t.co 展開）；一般網頁就用該頁網址
    const rawLinks = Array.isArray(sc.links) ? (sc.links as { url: string; label: string }[]) : []
    if (rawLinks.length) {
      m.links = await expandLinks(rawLinks)
    } else if (!isXUrl(url)) {
      m.links = [{ url: m.finalUrl, label: String(sc.siteName || '') }]
    }

    const imgs = Array.isArray(sc.images) ? (sc.images as string[]) : []
    const failedImgs: string[] = []
    for (const u of imgs.slice(0, 4)) {
      try {
        m.images.push(await downloadImage(u, imgDir, m.finalUrl))
      } catch {
        failedImgs.push(u)
      }
    }
    const twimg = failedImgs.filter(isTwimg)
    if (twimg.length) {
      try {
        const r = await downloadViaX(twimg, imgDir)
        m.images.push(...r.added)
      } catch {
        /* 圖抓不到不影響素材本身 */
      }
    }

    await saveMaterial(m)
    logOk(
      'material',
      `存入素材夾：${m.title || id}｜內文 ${[...m.text].length} 字｜圖 ${m.images.length}｜連結 ${m.links.length}`
    )
    return { url, id, title: m.title, ok: true }
  } catch (e) {
    const msg = (e as { message?: string }).message || String(e)
    logWarn('material', `抓取失敗 ${url}：${msg}`)
    try {
      await ensureDir(inboxDir())
      const id = await uniqueId(inboxDir(), materialSlugBase('', '', url))
      const m = emptyMaterial(id, url)
      m.platforms = platforms
      m.warning = '抓取失敗：' + msg
      await saveMaterial(m)
      return { url, id, ok: false, message: msg }
    } catch {
      return { url, ok: false, message: msg }
    }
  }
}
