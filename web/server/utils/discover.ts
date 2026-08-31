import { join } from 'node:path'

/**
 * 發掘：追蹤 X 帳號，用硬指標（不呼叫 AI）挑出有潛力的素材。
 *
 * 計分刻意全部做成純函式，可以被 npm test 直接 import——
 * 這個專案裡凡是依賴 Nitro auto-import 的「純函式」都測不到，前面踩過好幾次。
 * 檔案下半的讀寫函式才用 auto-import，兩邊不互相呼叫。
 */

// ── 型別 ──────────────────────────────────────────────────────────
export interface Source {
  /** 不含 @ 的帳號名 */
  handle: string
  enabled: boolean
  /** 給人看的備註 */
  note: string
}

/**
 * 計分權重。
 *
 * 沒有「配圖」這一項 —— 情報類推文幾乎都有圖，等於人人都拿滿分，
 * 不但分不出好壞，還會把物販完售通知那種有圖沒內容的東西往上抬。
 */
/** 網站來源。抓的是 RSS，不是爬版面 —— 版面會改，RSS 欄位不會 */
export interface WebSource {
  /** 網站首頁或 RSS 位址，兩種都收 */
  url: string
  /** 給人看的名字 */
  name: string
  enabled: boolean
  /** 實際用的 RSS 位址，第一次抓的時候自動找出來存起來 */
  feedUrl?: string
}

export interface Weights {
  /** 瀏覽數（再生数）——最接近「觸及」的指標 */
  views: number
  /** 讚＋轉＋回，反映的是鐵粉密度而不是觸及 */
  engagement: number
  recency: number
  keyword: number
}

export interface DiscoverSettings {
  sources: Source[]
  /** 主題關鍵字，命中才加分 */
  keywords: string[]
  /** 開著時要不要自動跑。預設關閉——自動連 X 這種事應該由使用者明確打開 */
  autoRun: boolean
  /** 幾小時跑一次（程式開著時） */
  intervalHours: number
  /** 分數到這個門檻就自動收進素材夾 */
  threshold: number
  weights: Weights
  /** 每個帳號最多看幾則 */
  maxPerAccount: number
  /** 超過幾天的推文直接不看 */
  lookbackDays: number
  /** 內文短於這個字數要扣分 */
  minTextLength: number
  /** 追蹤的新聞網站 */
  sites: WebSource[]
  /** 一個站最多看幾篇 */
  maxPerSite: number
  /** 抓取時每個帳號之間等幾秒 */
  gapSeconds: number
  /** 按下收錄時才去抓圖（發掘階段只留網址，不下載） */
  fetchImagesOnAccept: boolean
  /** 頁面抓不到圖時，用關鍵字去 X 搜圖。要動用瀏覽器佇列，預設關 */
  imageSearchX: boolean
  /** 一則素材最多收幾張圖 */
  maxImages: number
  lastRunAt: string
}

export interface Candidate {
  /** 去重主鍵。X 用 status id，Notion 用原始連結 */
  id: string
  /** x = 追蹤帳號；notion = 日報 */
  sourceType?: string
  /** Notion 來源時放廠商名 */
  sourceLabel?: string
  handle: string
  url: string
  text: string
  images: string[]
  links: { url: string; label: string }[]
  postedAt: string
  metrics: { replies: number; reposts: number; likes: number; views: number }
  isRepost: boolean
  isReply: boolean
  score: number
  breakdown: Record<string, number>
  /** Notion 日報在原頁面的名次（日報本身已依熱度排序，1 起算）。X 來源沒有 */
  rank?: number
  /** 收錄時如果頁面抓不到圖，拿這串去搜圖 */
  imageQuery?: string
  /** pending 待處理 / accepted 已收進素材夾 / ignored 已忽略 */
  status: string
  materialId: string
  foundAt: string
}

// ── 預設值 ────────────────────────────────────────────────────────
/** 規範第七節就是拿這幾個帳號當來源舉例的，當預設剛好 */
export const DEFAULT_SOURCES: Source[] = [
  { handle: 'Moepedia_net', enabled: true, note: '美少女遊戲行事曆、週邊情報' },
  { handle: 'gsc_kahotan', enabled: true, note: 'GSC 模型情報' }
]

/**
 * 主題關鍵字。X 那邊是日文、Notion 日報是簡體中文，兩套都要收，
 * 否則同一件事「発売」對得上、「发售」對不上。
 * 前段的類型詞取自使用者 Notion 裡那份「核心檢索詞」。
 */
export const DEFAULT_KEYWORDS = [
  // 類型
  'ギャルゲー', 'ノベルゲーム', '美少女ゲーム', 'ビジュアルノベル',
  '恋愛アドベンチャー', 'ADV', 'galgame', 'visual novel',
  '视觉小说', '文字冒险', '美少女游戏',
  // 動態（日文）
  '発売', '予約', '予約開始', '発表', '公開', '決定', '配信', '体験版',
  'グッズ', 'アクリル', 'タペストリー', 'フィギュア', 'POP UP', 'フェア',
  '周年', '誕生日', 'コラボ', '特典', '抽選', 'イベント',
  // 動態（簡體，Notion 日報用）
  '发售', '预约', '预售', '预约开始', '发表', '公开', '决定', '配信', '体验版',
  '周边', '手办', '挂轴', '抽选', '联动', '生日', '限定', '廉价版', '活动',
  'Steam'
]

export function defaultSettings(): DiscoverSettings {
  return {
    sources: DEFAULT_SOURCES.map(s => ({ ...s })),
    keywords: [...DEFAULT_KEYWORDS],
    autoRun: false,
    intervalHours: 4,
    threshold: 60,
    // 以瀏覽數為主：實測同一帳號 views 比讚數大兩三個數量級，
    // 讚數偏向鐵粉密度，views 才接近實際觸及
    weights: { views: 35, engagement: 15, recency: 25, keyword: 20 },
    sites: [],
    maxPerSite: 10,
    maxPerAccount: 10,
    lookbackDays: 3,
    minTextLength: 20,
    gapSeconds: 45,
    fetchImagesOnAccept: true,
    imageSearchX: false,
    maxImages: 4,
    lastRunAt: ''
  }
}

// ── 計分（純函式，不依賴任何 auto-import）────────────────────────
/** 互動數的參考點：到這個量就給滿分，取對數避免大帳號一則洗掉整批 */
export const ENGAGEMENT_REF = 2000
/** 瀏覽數的參考點。實測 galgame 官方帳號平常一則幾千，爆的一則二十幾萬 */
export const VIEWS_REF = 100_000

/** 瀏覽數（再生数）。同樣取對數，否則一則爆文會把整批洗掉 */
export function viewsScore(m: { views?: number }): number {
  const v = m.views || 0
  if (v <= 0) return 0
  return Math.min(1, Math.max(0, Math.log10(1 + v) / Math.log10(1 + VIEWS_REF)))
}

export function engagementScore(m: { replies?: number; reposts?: number; likes?: number }): number {
  const raw = (m.likes || 0) + 2 * (m.reposts || 0) + (m.replies || 0)
  if (raw <= 0) return 0
  const v = Math.log10(1 + raw) / Math.log10(1 + ENGAGEMENT_REF)
  return Math.min(1, Math.max(0, v))
}

/** 越新越高分，超過 lookbackDays 歸零 */
export function recencyScore(postedAt: string, lookbackDays: number, now = Date.now()): number {
  const t = Date.parse(postedAt || '')
  if (!Number.isFinite(t)) return 0
  const ageH = (now - t) / 3600_000
  if (ageH < 0) return 1
  const maxH = Math.max(1, lookbackDays * 24)
  if (ageH >= maxH) return 0
  return 1 - ageH / maxH
}

/** 命中一個關鍵字就有基本分，命中越多越高，但很快收斂 */
export function keywordScore(text: string, keywords: string[]): number {
  const t = String(text || '').toLowerCase()
  if (!t || !keywords.length) return 0
  let hits = 0
  for (const k of keywords) {
    const kk = String(k || '').trim().toLowerCase()
    if (kk && t.includes(kk)) hits++
  }
  if (!hits) return 0
  return Math.min(1, 0.6 + 0.2 * (hits - 1))
}

export interface ScoreInput {
  text: string
  images: string[]
  postedAt: string
  metrics: { replies?: number; reposts?: number; likes?: number; views?: number }
  isRepost: boolean
  isReply: boolean
}

/**
 * 0–100 分。權重相加不必等於 100，會自動正規化。
 * 扣分是乘法（打折）而不是減法，避免高互動的轉推硬是擠進門檻。
 */
export function scoreCandidate(
  c: ScoreInput,
  s: Pick<DiscoverSettings, 'keywords' | 'weights' | 'lookbackDays' | 'minTextLength'>,
  now = Date.now()
): { score: number; breakdown: Record<string, number> } {
  const w = s.weights
  const parts = {
    views: viewsScore(c.metrics || {}),
    engagement: engagementScore(c.metrics || {}),
    recency: recencyScore(c.postedAt, s.lookbackDays, now),
    keyword: keywordScore(c.text, s.keywords)
  }
  // 權重相加不必等於 100，會自動正規化。
  // 沒有的訊號（例如 Notion 來源沒有互動數）把權重設 0，其餘會自動補足。
  const total = (w.views || 0) + (w.engagement || 0) + (w.recency || 0) + (w.keyword || 0)
  const base =
    total > 0
      ? (parts.views * (w.views || 0) +
          parts.engagement * (w.engagement || 0) +
          parts.recency * (w.recency || 0) +
          parts.keyword * (w.keyword || 0)) /
        total
      : 0

  // 打折：這幾種東西即使數字很漂亮，對我們也沒有轉貼價值
  let penalty = 1
  if (c.isRepost) penalty *= 0.35
  if (c.isReply) penalty *= 0.5
  const len = [...String(c.text || '')].length
  if (len < (s.minTextLength || 0)) penalty *= 0.5
  // 一個主題關鍵字都沒中 —— 關鍵字清單就是「我們在乎什麼」的定義，
  // 沒中多半是帳號的營運瑣事（現場完售通知、系統維護之類），
  // 光靠新鮮度不該讓它過門檻
  if (parts.keyword === 0) penalty *= 0.55

  const score = Math.round(base * penalty * 100)
  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown: {
      瀏覽: Math.round(parts.views * 100),
      互動: Math.round(parts.engagement * 100),
      時效: Math.round(parts.recency * 100),
      主題: Math.round(parts.keyword * 100),
      折扣: Math.round(penalty * 100)
    }
  }
}

/**
 * 把貼進來的清單解析成追蹤帳號。刻意寬鬆——CSV、TSV、純一行一個都吃，
 * 帳號欄可以是 `handle`、`@handle` 或整個 `https://x.com/handle` 網址。
 * 第二欄當備註；看起來像表頭的那行會跳掉。
 */
export function parseHandleList(text: string): Source[] {
  const HEADER = /^(handle|account|username|user|帳號|账号|名稱|名称|帳戶)$/i
  const URL_RE = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i
  const out: Source[] = []
  const seen = new Set<string>()

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // 逗號、定位、分號都當分隔；引號包起來的欄位去掉引號
    const cells = line
      .split(/[,\t;]/)
      .map(c => c.trim().replace(/^["']|["']$/g, ''))
      .filter(c => c !== '')
    if (!cells.length) continue

    let handle = cells[0] as string
    const m = handle.match(URL_RE) // 整個網址也接受
    if (m) handle = m[1] as string
    handle = handle.replace(/^@/, '').trim()

    if (!handle || HEADER.test(handle)) continue
    // X 的帳號規則：英數與底線，最長 15 字
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue
    const key = handle.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    out.push({ handle, enabled: true, note: (cells[1] || '').slice(0, 60) })
  }
  return out
}

/**
 * 把貼進來的清單解析成網站來源。跟帳號那邊同一套規矩：
 * 一行一個，第一欄是網址、第二欄當名字，逗號／定位／分號都當分隔。
 */
export function parseSiteList(text: string): WebSource[] {
  const out: WebSource[] = []
  const seen = new Set<string>()

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const cells = line
      .split(/[,\t;]/)
      .map(c => c.trim().replace(/^["']|["']$/g, ''))
      .filter(c => c !== '')
    if (!cells.length) continue

    let url = cells[0] as string
    if (!/^https?:\/\//i.test(url)) {
      // 沒寫協定就補上，不然使用者貼 bugbug.news 會整行被丟掉
      if (!/^[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) continue
      url = 'https://' + url
    }
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push({ url, name: (cells[1] || host).slice(0, 40), enabled: true })
  }
  return out
}

/** 匯入網站清單時合併：同一個網域保留原本的設定 */
export function mergeSites(existing: WebSource[], incoming: WebSource[]) {
  const key = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      return u.toLowerCase()
    }
  }
  const out = existing.map(x => ({ ...x }))
  const idx = new Map(out.map((x, i) => [key(x.url), i]))
  let added = 0
  let updated = 0
  for (const inc of incoming) {
    const at = idx.get(key(inc.url))
    if (at === undefined) {
      out.push({ ...inc })
      idx.set(key(inc.url), out.length - 1)
      added++
    } else if (inc.name && !out[at]!.name) {
      out[at]!.name = inc.name
      updated++
    }
  }
  return { sites: out, added, updated }
}

/** 匯入時跟現有清單合併：同名的保留原本的設定，不覆蓋 */
export function mergeSources(existing: Source[], incoming: Source[]) {
  const out = existing.map(x => ({ ...x }))
  const idx = new Map(out.map((x, i) => [x.handle.toLowerCase(), i]))
  let added = 0
  let updated = 0
  for (const inc of incoming) {
    const at = idx.get(inc.handle.toLowerCase())
    if (at === undefined) {
      out.push({ ...inc })
      idx.set(inc.handle.toLowerCase(), out.length - 1)
      added++
    } else if (inc.note && !out[at]!.note) {
      out[at]!.note = inc.note
      updated++
    }
  }
  return { sources: out, added, updated }
}

/** 只留現在還有的權重欄位。舊設定檔留下的 image 之類會被丟掉 */
export function pickWeights(w: Record<string, unknown>): Weights {
  const n = (v: unknown, d: number) => {
    const x = Number(v)
    return Number.isFinite(x) && x >= 0 ? x : d
  }
  return {
    views: n(w.views, 35),
    engagement: n(w.engagement, 15),
    recency: n(w.recency, 25),
    keyword: n(w.keyword, 20)
  }
}

/** 從推文網址取出 status id，當去重主鍵 */
export function statusIdFromUrl(url: string): string {
  const m = String(url || '').match(/\/status\/(\d+)/)
  return m ? (m[1] as string) : ''
}


/** 已經看過、已經是素材、已經寫成貼文的，都不要再出現 */
export function isDuplicate(
  id: string,
  url: string,
  seen: string[],
  existingUrls: string[]
): boolean {
  if (!id && !url) return true
  if (id && seen.includes(id)) return true
  const uid = id || statusIdFromUrl(url)
  if (!uid) return false
  return existingUrls.some(u => statusIdFromUrl(u) === uid)
}

// ── 收錄時的抓圖（純函式部分）─────────────────────────────────────

/**
 * 一看就不是主視覺的圖：介面零件、社群按鈕、廣告、佔位圖。
 * 比對整串網址（含路徑與查詢字串），寧可錯殺——漏收一張圖比收到 logo 好。
 */
export const JUNK_IMAGE = new RegExp(
  [
    'logo', 'icon', 'favicon', 'avatar', 'sprite', 'spacer', 'blank', 'pixel',
    '1x1', 'badge', 'emoji', 'banner', 'bnr', 'btn[-_]', 'button', 'arrow',
    'share', 'sns[-_]', 'social', 'footer', 'header', 'nav[-_]', 'gnav',
    'ads?[-_.]', 'placeholder', 'loading', 'spinner', 'dummy', 'noimage',
    'no[-_]image', 'watermark', 'qrcode', 'amazon-adsystem', 'doubleclick',
    'googlesyndication', 'analytics', 'beacon'
  ].join('|'),
  'i'
)

/** 裝飾性格式。SVG 幾乎都是介面圖示，GIF 多半是動畫小圖 */
const DECOR_EXT = /\.(svg|ico|bmp)(\?|$)/i
const RASTER_EXT = /\.(jpe?g|png|webp)(\?|$)/i
/** 內容圖常見的存放路徑 */
const CONTENT_PATH = /(wp-content\/uploads|\/uploads?\/|\/images?\/|\/img\/|\/media\/|\/assets?\/|\/photo)/i

/** 把 `foo-1200x630.jpg`、`foo_thumb.jpg` 這種同圖不同尺寸的變體收斂成同一個鍵 */
export function imageDedupeKey(url: string): string {
  let u = url.split('?')[0] || url
  u = u.replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]{3,4}$)/i, '')
  u = u.replace(/[-_](thumb|small|medium|large|mini|s|m|l|xl)(?=\.[a-z]{3,4}$)/i, '')
  return u.toLowerCase()
}

/**
 * 從文章網址裡挑出「這篇的識別碼」。
 *
 * 用途：商品頁旁邊常常掛一排別的商品縮圖，光看路徑跟主圖長得一模一樣
 * （實測 getchu 的商品頁，前七張有五張是別的作品）。但這一頁自己的圖，
 * 網址裡多半帶著同一個 id —— `/item/1373661/` 的主圖在 `/brandnew/1373661/`。
 * 拿這個當訊號就分得開，而且不必為個別網站寫規則。
 */
export function urlIdTokens(pageUrl: string): string[] {
  try {
    const segs = new URL(pageUrl).pathname.split('/').filter(Boolean)
    return segs.filter(x => /^[A-Za-z0-9_-]{4,}$/.test(x) && /\d/.test(x)).slice(-3)
  } catch {
    return []
  }
}

/**
 * 幫網頁上抓到的圖排序，最像「這篇文章的主圖」的排前面。
 *
 * 判斷依據刻意只用網址本身，因為這一步還沒下載——真正的把關在下載後看
 * 實際尺寸（@see imageSize）。這裡的工作是決定「先下載哪幾張」。
 *
 * @param images   頁面上所有圖片網址，依出現順序
 * @param hero     og:image／twitter:image 這類站方自己指定的代表圖
 * @param pageUrl  文章網址，用來比對同網域
 */
export function rankWebImages(images: string[], hero: string[] = [], pageUrl = ''): string[] {
  const heroSet = new Set(hero.map(h => h.trim()).filter(Boolean))
  let host = ''
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '')
  } catch {
    /* 沒給或給錯就不比對網域 */
  }

  const idTokens = urlIdTokens(pageUrl)
  const scored: { url: string; score: number }[] = []
  const seen = new Set<string>()
  const all = [...heroSet, ...images]

  all.forEach((raw, i) => {
    const url = String(raw || '').trim()
    if (!url || url.startsWith('data:')) return
    if (JUNK_IMAGE.test(url)) return
    const key = imageDedupeKey(url)
    if (seen.has(key)) return
    seen.add(key)

    let sc = 0
    // 站方自己指定的代表圖最可信，這就是分享到社群時會出現的那張
    if (heroSet.has(url)) sc += 100
    if (RASTER_EXT.test(url)) sc += 12
    if (DECOR_EXT.test(url)) sc -= 45
    if (CONTENT_PATH.test(url)) sc += 12
    if (host) {
      try {
        if (new URL(url).hostname.replace(/^www\./, '').endsWith(host)) sc += 8
      } catch {
        sc -= 5
      }
    }
    // 網址裡帶著這一頁的 id，多半就是這一頁自己的圖，不是旁邊那排別的商品
    if (idTokens.length && idTokens.some(t => url.includes(t))) sc += 40
    // 檔名裡帶得動的尺寸數字：1200 這種是內容圖，64、150 這種是縮圖
    const nums = (url.match(/\d{2,4}/g) || []).map(Number)
    const big = nums.filter(n => n >= 600 && n <= 4000).length
    const small = nums.filter(n => n > 0 && n <= 200).length
    sc += big * 10 - small * 8
    // 越早出現越可能是主圖，但只給很小的權重，免得蓋過上面的判斷
    sc -= Math.min(i, 20) * 0.4

    scored.push({ url, score: sc })
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .filter(x => x.score > -20)
    .map(x => x.url)
}

/**
 * 從檔頭讀出圖片長寬，不用任何影像函式庫。
 * 支援 PNG／JPEG／GIF／WebP，讀不出來回 null（當作不確定，交給大小門檻判斷）。
 */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  const b = buf
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

  // PNG: 89 50 4E 47，IHDR 固定在 offset 16
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32(16), height: u32(20) }
  }
  // GIF: 邏輯螢幕描述子，小端序
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) }
  }
  // WebP: RIFF....WEBP，VP8 / VP8L / VP8X 三種子格式長寬位置不同
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const fmt = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fmt === 'VP8X') {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))
      return { width: w, height: h }
    }
    if (fmt === 'VP8 ') {
      return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff }
    }
    if (fmt === 'VP8L') {
      const n = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  // JPEG: 逐段跳到 SOFn
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]!
      // SOF0-3、5-7、9-11、13-15 都帶長寬；C4/C8/CC 是別的東西
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16(i + 7), height: u16(i + 5) }
      }
      const len = u16(i + 2)
      if (len < 2) break
      i += 2 + len
    }
  }
  return null
}

/**
 * 下載回來之後的把關：太小、太窄長、檔案太輕的都不是主視覺。
 * 這一關擋掉的是網址看不出來的東西——CDN 出來的裁切縮圖、橫幅廣告。
 */
export function isUsableImage(buf: Uint8Array): { ok: boolean; why: string } {
  if (buf.length < 12 * 1024) return { ok: false, why: '檔案太小（' + Math.round(buf.length / 1024) + 'KB）' }
  const d = imageSize(buf)
  if (!d) return { ok: true, why: '' } // 讀不出格式就放行，大小已經過關
  if (d.width < 320 || d.height < 240) return { ok: false, why: `尺寸太小（${d.width}×${d.height}）` }
  const ratio = d.width / d.height
  if (ratio > 4 || ratio < 0.25) return { ok: false, why: `比例太極端（${d.width}×${d.height}），像橫幅或側欄` }
  return { ok: true, why: '' }
}

/**
 * 決定貼文首圖。站方指定的 og:image 通常就是主視覺，但有些站放的是
 * 480×480 這種小圖（實測 blog.aquaplus.jp 就是），那張當首圖太寒酸，
 * 所以只有「夠大的代表圖」才保住第一位，其餘一律大的排前面。
 */
export function orderImages(items: { name: string; long: number; area: number; hero: boolean }[]): string[] {
  const primary = items.filter(x => x.hero && x.long >= 800)
  const rest = items.filter(x => !(x.hero && x.long >= 800)).sort((a, b) => b.area - a.area)
  return [...primary, ...rest].map(x => x.name)
}

/**
 * 從候選池找一則。Notion 候選的 id 就是整串原文網址，經過路徑參數之後
 * 斜線會是 %2F 而不會被解回來，只比對原字串會永遠找不到，所以編碼前後都比。
 */
export function findCandidate(items: Candidate[], raw: string): Candidate | undefined {
  const key = String(raw || '')
  if (!key) return undefined
  let dec = key
  try {
    dec = decodeURIComponent(key)
  } catch {
    /* 不是合法的百分號編碼就照原樣比 */
  }
  return items.find(x => x.id === key || x.id === dec || encodeURIComponent(x.id) === key)
}

// ── 讀寫（用 auto-import，純函式不會呼叫這一段）──────────────────
export function discoverDir() {
  return join(dataDir(), 'discover')
}
export function sourcesPath() {
  return join(discoverDir(), 'sources.json')
}
export function candidatesPath() {
  return join(discoverDir(), 'candidates.json')
}
export function seenPath() {
  return join(discoverDir(), 'seen.json')
}

/** 已看過的 id 最多留這麼多，避免無限長 */
const MAX_SEEN = 3000
const MAX_CANDIDATES = 300

export async function loadDiscoverSettings(): Promise<DiscoverSettings> {
  const d = await readJson<Partial<DiscoverSettings>>(sourcesPath(), {})
  const base = defaultSettings()
  return {
    ...base,
    ...d,
    sources: Array.isArray(d.sources) ? d.sources : base.sources,
    sites: Array.isArray(d.sites) ? d.sites : base.sites,
    keywords: Array.isArray(d.keywords) ? d.keywords : base.keywords,
    // 舊設定檔可能還留著已經廢掉的 image 權重，只取現在有的欄位，
    // 不然它會混進正規化的分母，把所有分數同比壓低
    weights: pickWeights({ ...base.weights, ...(d.weights || {}) })
  }
}

export async function saveDiscoverSettings(s: Partial<DiscoverSettings>) {
  const cur = await loadDiscoverSettings()
  const next: DiscoverSettings = {
    ...cur,
    ...s,
    weights: pickWeights({ ...cur.weights, ...(s.weights || {}) })
  }
  next.sources = (next.sources || []).map(x => ({
    handle: String(x.handle || '').replace(/^@/, '').trim(),
    enabled: x.enabled !== false,
    note: String(x.note || '')
  }))
  next.sites = (next.sites || [])
    .map(x => ({
      url: String(x.url || '').trim(),
      name: String(x.name || '').trim(),
      enabled: x.enabled !== false,
      ...(x.feedUrl ? { feedUrl: String(x.feedUrl).trim() } : {})
    }))
    .filter(x => x.url)
  next.maxPerSite = Math.max(1, Math.min(40, Number(next.maxPerSite) || 10))
  next.keywords = (next.keywords || []).map(k => String(k).trim()).filter(Boolean)
  next.maxImages = Math.max(1, Math.min(10, Number(next.maxImages) || 4))
  next.fetchImagesOnAccept = next.fetchImagesOnAccept !== false
  next.imageSearchX = next.imageSearchX === true
  await writeJson(sourcesPath(), next)
  return next
}

export async function loadCandidates(): Promise<Candidate[]> {
  const d = await readJson<{ items?: Candidate[] }>(candidatesPath(), {})
  return Array.isArray(d.items) ? d.items : []
}

export async function saveCandidates(items: Candidate[]) {
  const sorted = [...items].sort((a, b) => b.score - a.score || (b.foundAt || '').localeCompare(a.foundAt || ''))
  await writeJson(candidatesPath(), { items: sorted.slice(0, MAX_CANDIDATES) })
}

export async function loadSeen(): Promise<string[]> {
  const d = await readJson<{ ids?: string[] }>(seenPath(), {})
  return Array.isArray(d.ids) ? d.ids : []
}

export async function saveSeen(ids: string[]) {
  await writeJson(seenPath(), { ids: [...new Set(ids)].slice(-MAX_SEEN) })
}
