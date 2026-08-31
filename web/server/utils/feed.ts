/**
 * 網站來源：讀 galgame 新聞站的 RSS。
 *
 * 為什麼是 RSS 而不是爬 HTML：新聞站的版面隨時會改，爬 DOM 每改版就壞一次；
 * RSS 的欄位是固定的，而且標題、連結、時間、內文、圖片一次全給。
 * 實測 BugBug（WordPress）的 feed 就長這樣，一則不缺。
 *
 * 解析全部寫成純函式，npm test 直接 import 得到，不依賴 Nitro auto-import。
 */

export interface FeedItem {
  title: string
  link: string
  /** ISO 字串，抓不到就空的 */
  postedAt: string
  summary: string
  /** 內文裡的第一張圖，收錄時當主圖 */
  image: string
  categories: string[]
  /**
   * 互動數。RSS 與爬列表頁都拿不到，只有走站台 API 的來源會有
   * （目前是 ymgal）。有的話計分就能用上瀏覽與互動那兩項。
   */
  metrics?: { views: number; likes: number; reposts: number; replies: number }
}

// ── 純函式 ────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'", '#39': "'"
}

export function decodeXmlEntities(s: string): string {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

/** 取出某個標籤的內容，CDATA 會剝掉 */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  if (!m) return ''
  return decodeXmlEntities(String(m[1] || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')).trim()
}

function attr(xml: string, name: string, key: string): string {
  const m = new RegExp(`<${name}\\b[^>]*\\b${key}=["']([^"']+)["']`, 'i').exec(xml)
  return m ? decodeXmlEntities(m[1]!) : ''
}

/** 把 HTML 拔成純文字，段落之間留一個空白 */
export function stripHtml(s: string): string {
  return decodeXmlEntities(
    String(s || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toIso(s: string): string {
  const t = Date.parse(String(s || '').trim())
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}

/**
 * 解析 RSS 2.0 或 Atom。兩種格式的欄位名不同，但要的東西一樣，
 * 所以在這裡就抹平，外面不用管來源是哪一種。
 */
export function parseFeed(xml: string, limit = 20): FeedItem[] {
  const src = String(xml || '')
  const isAtom = /<feed[\s>]/i.test(src) && /<entry[\s>]/i.test(src)
  const blocks = isAtom
    ? src.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
    : src.match(/<item[\s>][\s\S]*?<\/item>/gi) || []

  const out: FeedItem[] = []
  for (const b of blocks.slice(0, limit)) {
    const title = tag(b, 'title')
    // Atom 的連結在 <link href="…">，RSS 在 <link>文字</link>
    const link = isAtom ? attr(b, 'link', 'href') || tag(b, 'link') : tag(b, 'link') || attr(b, 'link', 'href')
    if (!title || !/^https?:\/\//i.test(link)) continue

    const rawBody =
      tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary')

    // 圖片依可信度排：媒體標籤 > 內文裡的 img
    const image =
      attr(b, 'media:content', 'url') ||
      attr(b, 'media:thumbnail', 'url') ||
      attr(b, 'enclosure', 'url') ||
      (/<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(rawBody)?.[1] ?? '')

    out.push({
      title,
      link,
      postedAt: toIso(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      summary: stripHtml(rawBody).slice(0, 600),
      image: decodeXmlEntities(image),
      categories: (b.match(/<category(?:\s[^>]*)?>[\s\S]*?<\/category>/gi) || [])
        .map(c => tag(c, 'category'))
        .filter(Boolean)
        .slice(0, 6)
    })
  }
  return out
}

/**
 * 從首頁 HTML 找出 RSS 位址。
 * 大部分站會用 <link rel="alternate" type="application/rss+xml"> 宣告，
 * 沒宣告的話 WordPress 幾乎都在 /feed/，所以那個當退路。
 */
export function discoverFeedUrl(html: string, baseUrl: string): string {
  const links = String(html || '').match(/<link\b[^>]*>/gi) || []
  for (const l of links) {
    if (!/rel=["']?alternate/i.test(l)) continue
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(l)) continue
    const href = /href=["']([^"']+)["']/i.exec(l)?.[1]
    if (href) {
      try {
        return new URL(decodeXmlEntities(href), baseUrl).toString()
      } catch {
        /* 網址壞掉就看下一個 */
      }
    }
  }
  try {
    return new URL('/feed/', baseUrl).toString()
  } catch {
    return ''
  }
}

/** 一篇文章當成候選時的 id。用網址，跟 Notion 那條線一致 */
export function feedItemId(it: Pick<FeedItem, 'link'>): string {
  return String(it.link || '').split('#')[0] || ''
}

/**
 * 把某些權重歸零，其餘自動補足。
 * 網站文章沒有瀏覽數也沒有互動數，那兩項留著只會把所有分數同比壓低。
 */
export function weightsFor(w: Weights, zero: (keyof Weights)[]): Weights {
  const out = { ...w }
  for (const k of zero) out[k] = 0
  return out
}

/**
 * 沒有 RSS 的站，從列表頁挑出「像文章」的連結。
 *
 * 判斷方式刻意通用，不寫任何一個站的規則：同網域、路徑裡有一段數字
 * （文章 id 或日期，幾乎所有新聞站都這樣）、連結文字夠長（導覽列的
 * 「首頁」「一覧」那種都很短）、而且不是分類／標籤／分頁那類清單頁。
 *
 * 實測 Getchu 的新作列表就是這樣抓出 16 篇 /item/1375507/，
 * 連結文字剛好就是標題。
 */
const LIST_PATH = /\/(category|categories|tag|tags|page|author|search|archive|feed|login|cart)\//i

export function extractArticleLinks(
  html: string,
  baseUrl: string,
  limit = 40
): { url: string; title: string }[] {
  let host = ''
  try {
    host = new URL(baseUrl).hostname.replace(/^www\./, '')
  } catch {
    return []
  }

  // 同一篇文章常被連兩次（縮圖一次、標題一次），留文字比較長的那個
  const best = new Map<string, string>()
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const raw = decodeXmlEntities(m[1]!)
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue

    let u: URL
    try {
      u = new URL(raw, baseUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(u.protocol)) continue
    if (u.hostname.replace(/^www\./, '') !== host) continue
    if (LIST_PATH.test(u.pathname)) continue
    // 路徑裡要有一段三位數以上的數字：文章 id 或年月日
    if (!/\d{3,}/.test(u.pathname)) continue

    const title = stripHtml(m[2] || '').replace(/\s+/g, ' ').trim()
    if ([...title].length < 8) continue

    const key = u.toString().split('#')[0]!
    const prev = best.get(key) || ''
    if (title.length > prev.length) best.set(key, title)
  }

  return [...best.entries()].slice(0, limit).map(([url, title]) => ({ url, title }))
}
