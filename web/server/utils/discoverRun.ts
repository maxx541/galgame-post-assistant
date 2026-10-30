import { join } from 'node:path'
import fs from 'node:fs/promises'

/**
 * 發掘的執行核心：走訪追蹤帳號 → 去重 → 計分 → 高分自動收進素材夾。
 * 手動按鈕與排程器都呼叫這裡，邏輯只有一份。
 *
 * 會碰到 X，所以每個帳號之間留 gapSeconds 的間隔；
 * 抓取本身走 xTimeline，那條路已經在既有的 profile 佇列上。
 */

export interface RunReport {
  startedAt: string
  finishedAt: string
  /** 走訪了幾個帳號 */
  accounts: number
  /** Notion 讀了幾頁日報、解析出幾則 */
  notionPages: number
  notionEntries: number
  /** 讀到幾則推文 */
  fetched: number
  /** 去重後剩幾則 */
  fresh: number
  /** 因為之前處理過而跳掉幾則。沒有這個數字，畫面上只會顯示「新的 0 則」，
   *  使用者看不出到底是沒抓到還是全部都看過了 */
  skipped: number
  /** 進到候選池幾則 */
  added: number
  /** 分數過門檻、直接變成素材幾則 */
  autoAccepted: number
  errors: { handle: string; message: string }[]
  warnings: string[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 已經是素材或貼文的推文網址，用來去重 */
async function existingSourceUrls(): Promise<string[]> {
  const out: string[] = []
  try {
    for (const m of await listMaterials()) {
      if (m.url) out.push(m.url)
      if (m.finalUrl) out.push(m.finalUrl)
    }
  } catch {
    /* 素材夾讀不到不該擋住整個流程 */
  }
  try {
    for (const p of await listPosts()) {
      if (p.sourceUrl) out.push(p.sourceUrl)
      // 合併撰寫的貼文，補充素材的網址也算用過了
      for (const s of p.sources) if (s.url) out.push(s.url)
    }
  } catch {
    /* 同上 */
  }
  return out
}

/**
 * 下載一張圖並用實際內容把關。網址看起來像主圖、下載回來卻是 200×60 的
 * 橫幅，這種只有下載後才驗得出來，所以不合格的就刪掉。
 */
async function downloadChecked(
  url: string,
  dir: string,
  referer: string
): Promise<{ name: string; long: number; area: number }> {
  const name = await downloadImage(url, dir, referer)
  const file = join(dir, name)
  const buf = await fs.readFile(file)
  const v = isUsableImage(buf)
  if (!v.ok) {
    await fs.rm(file, { force: true })
    throw new Error(v.why)
  }
  const d = imageSize(buf)
  return { name, long: d ? Math.max(d.width, d.height) : 0, area: d ? d.width * d.height : 0 }
}


/**
 * 收錄時才抓圖。發掘階段只留網址不下載——候選大多數最後不會被收，
 * 先抓等於白抓一堆圖，也讓每次發掘慢上好幾倍。
 *
 * 三層，前一層拿到足夠的圖就不往下走：
 *   1. 候選自己帶的圖（X 推文的 pbs.twimg.com，直連失敗改用已登入的 context）
 *   2. 原文網頁：og:image 這類站方指定的代表圖優先，其餘用 rankWebImages 排序
 *   3. 關鍵字去 X 搜熱門推文的圖（要開設定，會佔用瀏覽器佇列）
 */
async function acquireImages(
  c: Candidate,
  imgDir: string,
  s: DiscoverSettings
): Promise<{ names: string[]; notes: string[] }> {
  const names: string[] = []
  const notes: string[] = []
  const max = Math.max(1, s.maxImages || 4)

  // ── 第一層：候選自己帶的圖
  const failed: string[] = []
  for (const u of (c.images || []).slice(0, max)) {
    try {
      names.push(await downloadImage(u, imgDir, c.url))
    } catch {
      failed.push(u)
    }
  }
  const twimg = failed.filter(isTwimg)
  if (twimg.length) {
    try {
      const r = await downloadViaX(twimg, imgDir)
      names.push(...r.added)
    } catch {
      /* 圖抓不到不影響素材本身 */
    }
  }
  if (names.length >= max || !s.fetchImagesOnAccept) return { names, notes }

  // ── 第二層：原文網頁
  if (c.url && !isXUrl(c.url)) {
    try {
      const page = await scrapeUrl(c.url)
      const hero = new Set(page.heroImages || [])
      const ranked = rankWebImages(page.images, page.heroImages, page.finalUrl || c.url)
      const got: { name: string; long: number; area: number; hero: boolean }[] = []
      let tried = 0
      let skipped = 0
      for (const u of ranked) {
        if (got.length >= max || tried >= 14) break
        tried++
        try {
          const r = await downloadChecked(u, imgDir, page.finalUrl || c.url)
          got.push({ ...r, hero: hero.has(u) })
        } catch (e) {
          skipped++
          logInfo('discover', `跳過一張圖：${(e as Error).message} ${sliceChars(u, 70)}`)
        }
      }
      names.push(...orderImages(got))
      if (got.length) notes.push(`原文網頁取得 ${got.length} 張圖${skipped ? `（篩掉 ${skipped} 張）` : ''}`)
      else notes.push('原文網頁沒有可用的圖')
    } catch (e) {
      notes.push('原文網頁讀取失敗：' + (e as Error).message)
    }
  }
  if (names.length || !s.imageSearchX) return { names, notes }

  // ── 第三層：拿關鍵字去 X 搜熱門推文的圖
  const q = (c.imageQuery || c.sourceLabel || '').trim()
  if (!q) return { names, notes }
  try {
    const hits = await xSearch(q, 8)
    const urls: string[] = []
    for (const t of hits) {
      for (const u of t.images || []) {
        if (!urls.includes(u)) urls.push(u)
      }
      if (urls.length >= max) break
    }
    for (const u of urls.slice(0, max)) {
      try {
        names.push(await downloadImage(u, imgDir, 'https://x.com/'))
      } catch {
        /* 直連失敗下面統一補救 */
      }
    }
    if (!names.length && urls.length) {
      try {
        const r = await downloadViaX(urls.slice(0, max), imgDir)
        names.push(...r.added)
      } catch {
        /* 同上 */
      }
    }
    notes.push(names.length ? `X 搜「${q}」取得 ${names.length} 張圖` : `X 搜「${q}」也沒有圖`)
  } catch (e) {
    notes.push('X 搜圖失敗：' + (e as Error).message)
  }
  return { names, notes }
}

/**
 * 候選 → 素材。走既有的 saveMaterial，不另外寫一套。
 */
export async function candidateToMaterial(c: Candidate): Promise<string> {
  const s = await loadDiscoverSettings()
  await ensureDir(inboxDir())
  const id = await uniqueId(inboxDir(), materialSlugBase('', c.text, c.url))
  const imgDir = join(inboxDir(), id, 'images')
  await ensureDir(imgDir)

  const m = emptyMaterial(id, c.url)
  m.title = sliceChars(String(c.text || '').split('\n').map(x => x.trim()).find(Boolean) || '', 40)
  m.finalUrl = c.url
  m.text = c.text
  const isX = (c.sourceType || 'x') === 'x'
  m.handle = isX ? '@' + c.handle : ''
  m.sourceGuess = isX ? '@' + c.handle : c.sourceLabel || c.handle
  m.via = isX ? 'discover' : 'notion'
  m.postedAt = c.postedAt
  m.links = (c.links || []).filter(l => l.url?.trim())
  m.platforms = ['facebook']

  const { names, notes } = await acquireImages(c, imgDir, s)
  m.images.push(...names)

  await saveMaterial(m)
  logOk(
    'discover',
    `收錄 ${isX ? '@' + c.handle : c.sourceLabel || 'Notion'} → ${id}` +
      `，圖 ${names.length} 張${notes.length ? `（${notes.join('；')}）` : ''}`
  )
  return id
}

/**
 * 跑一次發掘。
 * @param handles 只跑這幾個帳號；不給就跑所有 enabled 的
 */
export async function runDiscover(handles?: string[], ctx?: JobCtx): Promise<RunReport> {
  // 兩條線各自獨立，這支只是「兩個都跑」的方便入口（排程器在用）
  const a = await runNotion(ctx)
  const b = await runX(handles, ctx)
  return {
    ...b,
    startedAt: a.startedAt,
    notionPages: a.notionPages,
    notionEntries: a.notionEntries,
    fresh: a.fresh + b.fresh,
    skipped: a.skipped + b.skipped,
    added: a.added + b.added,
    autoAccepted: a.autoAccepted + b.autoAccepted,
    errors: [...a.errors, ...b.errors],
    warnings: [...a.warnings, ...b.warnings]
  }
}

function emptyReport(): RunReport {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    accounts: 0,
    notionPages: 0,
    notionEntries: 0,
    fetched: 0,
    fresh: 0,
    skipped: 0,
    added: 0,
    autoAccepted: 0,
    errors: [],
    warnings: []
  }
}

/**
 * 只讀 Notion 日報。不碰 X，所以幾秒就跑完 ——
 * 跟推特抓取分開之後，想單獨更新日報不用等一小時的 X 抓取。
 */
export async function runNotion(ctx?: JobCtx, force = false): Promise<RunReport> {
  const report = emptyReport()
  const notion = await loadNotionSettings()
  if (!notion.enabled || !notion.token) {
    report.finishedAt = new Date().toISOString()
    report.warnings.push('Notion 日報沒有啟用，或還沒填 token')
    return report
  }

  ctx?.setTotal(1)
  ctx?.note(force ? '重讀 Notion 日報（含之前處理過的）…' : '讀取 Notion 日報…')
  const seen = await loadSeen()
  const candidates = await loadCandidates()
  const existing = await existingSourceUrls()

  try {
    const { pages, entries } = await fetchDigestEntries(notion)
    report.notionPages = pages.length
    report.notionEntries = entries.length
    let rank = 0

    const inPool = new Set(candidates.map(c => c.id))
    for (const e of entries) {
      if (!e.url) continue
      // 已經變成素材或貼文的一律不再收；已讀紀錄則在 force 時忽略
      if (existing.includes(e.url) || inPool.has(e.id)) {
        report.skipped++
        continue
      }
      if (!force && seen.includes(e.id)) {
        report.skipped++
        continue
      }
      if (!seen.includes(e.id)) seen.push(e.id)
      report.fresh++
      rank++

      // 日報本身已經按熱度排好，名次直接沿用原順序；
      // 條目沒有圖也沒有互動數，套 X 那套評分只會算出一個假的分數，所以不計分。
      candidates.unshift({
        id: e.id,
        sourceType: 'notion',
        sourceLabel: [e.source, e.work].filter(Boolean).join('｜'),
        handle: e.source || 'Notion',
        url: e.url,
        text: e.text,
        images: [],
        imageQuery: e.work || e.source || '',
        links: [{ url: e.url, label: e.source || '' }],
        postedAt: e.date ? `${e.date}T12:00:00Z` : '',
        metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
        isRepost: false,
        isReply: false,
        score: 0,
        breakdown: {},
        rank,
        status: 'pending',
        materialId: '',
        foundAt: new Date().toISOString()
      })
      report.added++
    }

    await saveSeen(seen)
    await saveCandidates(candidates)
    logOk('discover', `Notion：${pages.length} 頁日報、新的 ${report.added} 則、跳過 ${report.skipped} 則`)
    ctx?.step(
      `Notion 日報：${pages.length} 頁、解析 ${entries.length} 則，新的 ${report.added} 則` +
        (report.skipped ? `（${report.skipped} 則之前處理過）` : '')
    )
  } catch (e) {
    const msg = (e as { message?: string }).message || String(e)
    report.errors.push({ handle: 'Notion', message: msg })
    logWarn('discover', 'Notion 讀取失敗：' + msg)
    ctx?.step('Notion 讀取失敗：' + msg, false)
  }

  report.finishedAt = new Date().toISOString()
  await appendRunLog(report)
  return report
}

/**
 * 讀網站來源（RSS）。
 *
 * **不計分**，照發佈時間列出來讓使用者自己挑。
 *
 * 為什麼不套推特那套：新聞站的瀏覽數是慢慢累積的，推文則是幾小時內就衝完。
 * 同一組權重套下去，剛發的新聞反而比三天前的分數低（實測 40 vs 48），
 * 排序完全反過來。等想清楚新聞該怎麼評再說，現在只有推特計分。
 */
export async function runWeb(ctx?: JobCtx): Promise<RunReport> {
  const report = emptyReport()
  const s = await loadDiscoverSettings()
  const targets = s.sites.filter(x => x.enabled && x.url)

  if (!targets.length) {
    report.finishedAt = new Date().toISOString()
    report.warnings.push('沒有啟用中的網站來源')
    return report
  }

  logInfo('discover', `開始抓取 ${targets.length} 個網站`)
  ctx?.setTotal(targets.length)

  const seen = await loadSeen()
  const candidates = await loadCandidates()
  const existing = await existingSourceUrls()
  const now = Date.now()

  for (const site of targets) {
    if (ctx?.shouldStop()) {
      ctx.note('已停止，剩下的網站沒有抓')
      break
    }
    const label = site.name || site.url
    try {
      ctx?.note(`讀取 ${label}…`)
      const { items, feedUrl, via } = await fetchSiteFeed(site, s.maxPerSite)
      // 找到的 RSS 位址存起來，下次不用再去首頁翻一遍
      if (feedUrl && feedUrl !== site.feedUrl) site.feedUrl = feedUrl
      report.accounts++
      report.fetched += items.length

      let fresh = 0
      for (const it of items) {
        const id = feedItemId(it)
        if (!id) continue
        if (seen.includes(id) || existing.includes(id)) {
          report.skipped++
          continue
        }
        // 太舊的不看，跟推特那條線同一個規則。
        // 但爬列表頁的文章常常拿不到發佈時間，那種不能直接刷掉 ——
        // 列表頁本來就是新的在前面，沒日期不代表它舊。
        if (it.postedAt && recencyScore(it.postedAt, s.lookbackDays, now) <= 0) {
          report.skipped++
          continue
        }
        seen.push(id)
        report.fresh++
        fresh++

        const text = [it.title, it.summary].filter(Boolean).join('\n\n')
        const metrics = it.metrics || { views: 0, likes: 0, reposts: 0, replies: 0 }

        const c: Candidate = {
          id,
          sourceType: 'web',
          sourceLabel: label,
          handle: label,
          url: it.link,
          text,
          images: it.image ? [it.image] : [],
          imageQuery: it.title,
          links: [{ url: it.link, label }],
          postedAt: it.postedAt,
          metrics,
          isRepost: false,
          isReply: false,
          score: 0,
          breakdown: {},
          status: 'pending',
          materialId: '',
          foundAt: new Date().toISOString()
        }

        candidates.unshift(c)
        report.added++
      }

      await saveSeen(seen)
      await saveCandidates(candidates)
      const how = via === 'html' ? '（爬列表頁）' : via === 'api' ? '（站台 API）' : ''
      ctx?.step(`${label}：讀到 ${items.length} 篇，新的 ${fresh} 篇${how}`)
    } catch (e) {
      const msg = (e as { message?: string }).message || String(e)
      report.errors.push({ handle: label, message: msg })
      logWarn('discover', `${label} 抓取失敗：${msg}`)
      ctx?.step(`${label} 抓取失敗：${msg}`, false)
    }
  }

  await saveDiscoverSettings({ sites: s.sites })
  report.finishedAt = new Date().toISOString()
  logOk('discover', `網站抓取完成：${report.accounts} 個站、${report.fetched} 篇、新的 ${report.fresh} 篇`)
  await appendRunLog(report)
  return report
}

/**
 * 拿一個站的文章列表。兩條路，優先走上面那條：
 *
 *   1. RSS —— 欄位固定，改版也不會壞。給首頁的話會自己去找 feed 位址
 *      （<link rel=alternate>，找不到就試 WordPress 慣例的 /feed/）。
 *   2. 沒有 RSS 就爬列表頁 —— 用通用的啟發式挑出「像文章」的連結
 *      （同網域、路徑帶數字 id、連結文字夠長），再逐篇讀那頁拿標題、
 *      內文、代表圖與發佈時間。Getchu 這種沒有 feed 的站就是走這條。
 *
 * 找到的 feed 位址會存回設定，下次不用再翻一遍首頁。
 */
export async function fetchSiteFeed(site: WebSource, limit: number) {
  // 有專屬 API 的站先走 API —— 拿到的東西比爬頁面完整，ymgal 連互動數都給
  if (isYmgal(site.url)) {
    return { items: await fetchYmgal(limit), feedUrl: '', via: 'api' as const }
  }

  const tryUrls = [site.feedUrl, site.url].filter(Boolean) as string[]
  let lastErr = ''
  let listingHtml = ''
  let listingUrl = ''

  for (const u of tryUrls) {
    const r = await readFeed(u, limit)
    if (r.items.length) return { items: r.items, feedUrl: u, via: 'rss' as const }
    if (r.html) {
      listingHtml = r.html
      listingUrl = u
      const found = discoverFeedUrl(r.html, u)
      if (found && found !== u) {
        const r2 = await readFeed(found, limit)
        if (r2.items.length) return { items: r2.items, feedUrl: found, via: 'rss' as const }
      }
      lastErr = '這個網址沒有可用的 RSS'
    } else {
      lastErr = r.error || '讀不到內容'
    }
  }

  // ── 退路：爬列表頁
  if (listingHtml) {
    const links = extractArticleLinks(listingHtml, listingUrl, limit * 2)
    if (links.length) {
      const items = await scrapeArticles(links.slice(0, limit))
      if (items.length) return { items, feedUrl: '', via: 'html' as const }
      lastErr = `列表頁找到 ${links.length} 個連結，但每一篇都讀不出內容`
    } else {
      lastErr = '沒有 RSS，列表頁也挑不出像文章的連結'
    }
  }

  throw createError({ statusCode: 502, message: lastErr || '讀不到這個站的文章' })
}

/**
 * 逐篇讀文章頁。走既有的 scrapeUrl —— 年齡確認 cookie 與編碼判斷都在裡面，
 * Getchu 那種 EUC-JP + 年齡閘的站不另外處理也通得過。
 */
async function scrapeArticles(links: { url: string; title: string }[]): Promise<FeedItem[]> {
  const out: FeedItem[] = []
  for (const l of links) {
    try {
      const page = await scrapeUrl(l.url)
      const title = page.title || l.title
      if (!title) continue
      out.push({
        title,
        link: page.finalUrl || l.url,
        postedAt: page.publishedAt || '',
        summary: (page.description || '').slice(0, 600),
        image: page.heroImages[0] || page.images[0] || '',
        categories: []
      })
    } catch {
      // 單篇讀不到就跳過，不要讓整個站失敗
    }
  }
  return out
}

async function readFeed(url: string, limit: number) {
  try {
    // 年齡閘的站（Getchu 那類）不帶 cookie 只會拿到年齡確認頁；
    // 編碼也要照 Content-Type 判斷，不然 EUC-JP 的標題會整串變亂碼
    const cookie = ageCookieFor(url)
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; galgame-post-tool/1.0)',
        accept: 'application/rss+xml,application/atom+xml,application/xml,text/html;q=0.8',
        'accept-language': 'ja,zh-TW;q=0.8,en;q=0.6',
        ...(cookie ? { cookie } : {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) return { items: [], html: '', error: `HTTP ${res.status}` }
    const body = decodeBody(await res.arrayBuffer(), res.headers.get('content-type') || '')
    const items = parseFeed(body, limit)
    // 解析不出文章就把原文交回去，讓上面判斷是不是 HTML
    return { items, html: items.length ? '' : body, error: '' }
  } catch (e) {
    return { items: [], html: '', error: (e as Error).message }
  }
}

/** 只抓 X 追蹤帳號 */
export async function runX(handles?: string[], ctx?: JobCtx): Promise<RunReport> {
  // ctx 有給就回報進度，沒給（排程器呼叫）就靜靜跑
  const step = (t: string, ok = true) => ctx?.step(t, ok)
  const note = (t: string, ok = true) => ctx?.note(t, ok)
  const s = await loadDiscoverSettings()
  const report = emptyReport()

  const targets = s.sources.filter(
    x => x.enabled && x.handle && (!handles?.length || handles.includes(x.handle))
  )
  if (!targets.length) {
    report.finishedAt = new Date().toISOString()
    report.warnings.push('沒有啟用中的追蹤帳號')
    logWarn('discover', '沒有任何啟用中的追蹤帳號，這次不跑')
    return report
  }

  logInfo('discover', `開始抓取 ${targets.length} 個 X 帳號`)
  ctx?.setTotal(targets.length)

  const seen = await loadSeen()
  const candidates = await loadCandidates()
  const existing = await existingSourceUrls()
  const now = Date.now()

  for (let i = 0; i < targets.length; i++) {
    if (ctx?.shouldStop()) {
      note('已停止，剩下的帳號沒有抓')
      break
    }
    const src = targets[i]!
    if (i > 0 && s.gapSeconds > 0) {
      note(`等 ${s.gapSeconds} 秒再抓下一個（避免連打 X）…`)
      if (ctx) await ctx.sleep(s.gapSeconds * 1000)
      else await sleep(s.gapSeconds * 1000)
    }

    try {
      note(`讀取 @${src.handle} 的時間軸…`)
      const r = await xTimeline(src.handle, s.maxPerAccount, ctx?.signal)
      report.accounts++
      report.fetched += r.tweets.length
      if (r.warning) report.warnings.push(`@${src.handle}：${r.warning}`)

      for (const t of r.tweets) {
        // 置頂推文常常是好幾個月前的公告，不當新素材
        if (t.isPinned) continue
        // 超過回看天數的直接不看（lookbackDays 的語意就是這個）
        if (recencyScore(t.postedAt, s.lookbackDays, now) <= 0) continue
        if (isDuplicate(t.id, t.url, seen, existing)) {
          report.skipped++
          continue
        }
        seen.push(t.id)
        report.fresh++

        const { score, breakdown } = scoreCandidate(
          {
            text: t.text,
            images: t.images,
            postedAt: t.postedAt,
            metrics: t.metrics,
            isRepost: t.isRepost,
            isReply: t.isReply
          },
          s,
          now
        )

        const c: Candidate = {
          id: t.id,
          sourceType: 'x',
          handle: src.handle,
          url: t.url,
          text: t.text,
          images: t.images,
          links: t.links,
          postedAt: t.postedAt,
          metrics: t.metrics,
          isRepost: t.isRepost,
          isReply: t.isReply,
          score,
          breakdown,
          status: 'pending',
          materialId: '',
          foundAt: new Date().toISOString()
        }

        if (score >= s.threshold) {
          try {
            c.materialId = await candidateToMaterial(c)
            c.status = 'accepted'
            report.autoAccepted++
            logOk('discover', `自動收錄（${score} 分）@${src.handle}：${sliceChars(t.text, 30)}`)
          } catch (e) {
            // 收錄失敗就退回候選池，不要整批中斷
            report.errors.push({ handle: src.handle, message: '自動收錄失敗：' + (e as Error).message })
          }
        }
        candidates.unshift(c)
        report.added++
      }
      // 每個帳號抓完就先存，畫面才會一則一則跑出來，
      // 而不是整輪跑完（可能一小時）才一次全部冒出來
      await saveSeen(seen)
      await saveCandidates(candidates)
      step(
        `@${src.handle}：讀到 ${r.tweets.length} 則，新的 ${report.fresh} 則（累計）` +
          (r.warning ? `｜${r.warning}` : '')
      )
    } catch (e) {
      const msg = (e as { message?: string }).message || String(e)
      report.errors.push({ handle: src.handle, message: msg })
      logWarn('discover', `@${src.handle} 抓取失敗：${msg}`)
      step(`@${src.handle} 抓取失敗：${msg}`, false)
    }
  }

  await saveSeen(seen)
  await saveCandidates(candidates)
  await saveDiscoverSettings({ lastRunAt: new Date().toISOString() })

  report.finishedAt = new Date().toISOString()
  logOk(
    'discover',
    `X 抓取完成：${report.accounts} 個帳號、讀到 ${report.fetched} 則、新的 ${report.fresh} 則、` +
      `自動收錄 ${report.autoAccepted} 則${report.errors.length ? `、${report.errors.length} 個帳號失敗` : ''}`
  )
  await appendRunLog(report)
  return report
}

/** 抓取紀錄，給頁面顯示 */
export function runLogPath() {
  return join(discoverDir(), 'runs.json')
}

export async function loadRunLog(): Promise<RunReport[]> {
  const d = await readJson<{ items?: RunReport[] }>(runLogPath(), {})
  return Array.isArray(d.items) ? d.items : []
}

async function appendRunLog(r: RunReport) {
  const items = await loadRunLog()
  items.unshift(r)
  await writeJson(runLogPath(), { items: items.slice(0, 40) })
}
