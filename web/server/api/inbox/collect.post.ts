import { join } from 'node:path'

/**
 * 一次貼多個連結，逐一抓取後放進素材夾。
 *
 * 這支只負責「開一個背景工作」馬上回 jobId —— 抓取本身在伺服器上跑完。
 * 以前是同步跑完才回應，使用者一切換視窗，瀏覽器把分頁降級就斷在半路。
 *
 * 抓失敗的也會建立素材（帶 warning），讓你可以手動補內容或貼圖，而不是整批消失。
 *
 * merge=true 時所有連結併成「一則」素材：文字依序串起來、圖片全部放進同一個資料夾。
 * 適合同一件事分好幾則推文發的情況，不用抓完再手動合併。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ urls?: string[]; text?: string; platforms?: string[]; merge?: boolean }>(event)
  const urls = (body?.urls?.length ? body.urls : extractUrls(body?.text || '')).slice(0, 20)
  if (!urls.length) throw createError({ statusCode: 400, message: '沒有找到任何 http(s) 網址' })

  const platforms = body?.platforms?.length ? body.platforms : ['facebook']
  const merge = !!body?.merge && urls.length > 1

  const job = startJob(
    'collect',
    merge ? `抓取 ${urls.length} 個連結（合併成一則）` : `抓取 ${urls.length} 個連結`,
    async ctx => {
      ctx.setTotal(urls.length)
      if (merge) return collectMerged(urls, platforms, ctx)

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

  return { jobId: job.id, total: urls.length, merge }
})

interface CollectResult {
  url: string
  id?: string
  title?: string
  ok: boolean
  message?: string
}

/** 讀一個網址，回傳統一格式的抓取結果。失敗會丟例外 */
async function scrapeAny(url: string): Promise<Record<string, unknown>> {
  // X／Facebook／Instagram 都有登入牆，走 Playwright + 已登入的 profile
  if (isXUrl(url) || isSocialUrl(url)) {
    try {
      return (isXUrl(url)
        ? toScrapeResult(await xScrape(url))
        : toScrapeResultSocial(await socialScrape(url))) as unknown as Record<string, unknown>
    } catch (e) {
      const r = await scrapeUrl(url)
      return {
        ...r,
        via: 'fetch',
        text: r.description,
        warning: ['Playwright 讀取失敗，已退回一般抓取。', (e as Error).message, r.warning]
          .filter(Boolean)
          .join(' ')
      }
    }
  }
  const r = await scrapeUrl(url)
  return { ...r, via: 'fetch', text: r.description }
}

/** 導流連結：推文取內文裡的外連（t.co 展開）；一般網頁就用該頁網址 */
async function linksOf(sc: Record<string, unknown>, url: string): Promise<{ url: string; label: string }[]> {
  const rawLinks = Array.isArray(sc.links) ? (sc.links as { url: string; label: string }[]) : []
  if (rawLinks.length) return expandLinks(rawLinks)
  if (!isXUrl(url) && !isSocialUrl(url)) return [{ url: String(sc.finalUrl || url), label: String(sc.siteName || '') }]
  return []
}

/** 把抓到的圖下載進 imgDir，回傳存下的檔名。圖抓不到不影響素材本身 */
async function downloadImages(sc: Record<string, unknown>, imgDir: string, referer: string) {
  const out: string[] = []
  const imgs = Array.isArray(sc.images) ? (sc.images as string[]) : []
  const failedImgs: string[] = []
  for (const u of imgs.slice(0, 4)) {
    try {
      out.push(await downloadImage(u, imgDir, referer))
    } catch {
      failedImgs.push(u)
    }
  }
  const twimg = failedImgs.filter(isTwimg)
  if (twimg.length) {
    try {
      const r = await downloadViaX(twimg, imgDir)
      out.push(...r.added)
    } catch {
      /* 同上 */
    }
  }
  // Meta 的 CDN 網址帶簽章，直連常回 403，改用已登入的瀏覽器 context 再試一次
  const metaImgs = failedImgs.filter(isMetaCdn)
  if (metaImgs.length) {
    try {
      const r = await downloadViaSocial(metaImgs, imgDir)
      out.push(...r.added)
    } catch {
      /* 同上 */
    }
  }
  return out
}

/** 抓一個連結。丟不出例外 —— 失敗也要留下一則空素材讓使用者自己補 */
async function collectUrl(url: string, platforms: string[]): Promise<CollectResult> {
  try {
    logInfo('material', `抓取 ${url}`)
    const sc = await scrapeAny(url)

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
    m.links = await linksOf(sc, url)
    m.images.push(...(await downloadImages(sc, imgDir, m.finalUrl)))

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

/**
 * 合併模式：全部連結併成一則素材。
 * 第一個抓成功的決定標題、作者與資料夾名；文字依貼上的順序分段，每段標出來源網址。
 * 抓失敗的記在 warning 與內文裡，不另外建空素材。
 */
async function collectMerged(urls: string[], platforms: string[], ctx: JobCtx) {
  let m: Material | null = null
  let imgDir = ''
  const parts: string[] = []
  const warnings: string[] = []
  const sources = new Set<string>()
  let failed = 0

  for (const [i, url] of urls.entries()) {
    if (ctx.shouldStop()) {
      ctx.note('已停止，剩下的沒有抓')
      break
    }
    try {
      logInfo('material', `抓取（合併）${url}`)
      const sc = await scrapeAny(url)
      const title = String(sc.title || '')
      const text = String(sc.text || sc.description || '').trim()
      const finalUrl = String(sc.finalUrl || url)

      if (!m) {
        await ensureDir(inboxDir())
        const id = await uniqueId(inboxDir(), materialSlugBase(title, text, url))
        imgDir = join(inboxDir(), id, 'images')
        await ensureDir(imgDir)
        m = emptyMaterial(id, url)
        m.title = title
        m.finalUrl = finalUrl
        m.author = String(sc.author || '')
        m.handle = String(sc.handle || '')
        m.postedAt = String(sc.createdAt || '')
        m.via = String(sc.via || 'fetch')
        m.platforms = platforms
      }

      const src = String(sc.sourceGuess || sc.handle || '')
      if (src) sources.add(src)
      if (sc.warning) warnings.push(String(sc.warning))
      parts.push([`【來源 ${i + 1}】${src ? src + '｜' : ''}${title}`, finalUrl, '', text].join('\n'))

      for (const l of await linksOf(sc, url)) {
        if (!l.url || m.links.some(x => x.url === l.url)) continue
        m.links.push(l)
      }
      const added = await downloadImages(sc, imgDir, finalUrl)
      m.images.push(...added)
      ctx.step(`抓到「${title || url}」，${added.length} 張圖`, true)
    } catch (e) {
      failed++
      const msg = (e as { message?: string }).message || String(e)
      logWarn('material', `抓取失敗 ${url}：${msg}`)
      warnings.push(`抓取失敗 ${url}：${msg}`)
      parts.push(`【來源 ${i + 1}】抓取失敗\n${url}`)
      ctx.step(`失敗：${msg}`, false)
    }
  }

  if (!m) {
    // 全部失敗：留一則空素材，網址列進內文讓使用者自己補
    await ensureDir(inboxDir())
    const id = await uniqueId(inboxDir(), materialSlugBase('', '', urls[0]!))
    m = emptyMaterial(id, urls[0]!)
    m.platforms = platforms
    m.text = urls.join('\n')
    m.warning = warnings.join('\n')
    await saveMaterial(m)
    return { results: [{ url: urls[0], id, ok: false }], added: 0, failed }
  }

  m.text = parts.join('\n\n')
  m.sourceGuess = [...sources].join('、')
  m.warning = warnings.join('\n')
  await saveMaterial(m)
  logOk(
    'material',
    `合併存入素材夾：${m.title || m.id}｜${urls.length - failed}/${urls.length} 個連結｜內文 ${[...m.text].length} 字｜圖 ${m.images.length}`
  )
  return { results: [{ url: m.url, id: m.id, title: m.title, ok: true }], added: 1, failed, merged: true }
}
