/**
 * 月幕Galgame（ymgal.games）的 API 轉接器。
 *
 * 這個站沒有 RSS，列表頁也是前端渲染的，但它開了公開 API，而且回的東西
 * 比 RSS 還完整 —— **連瀏覽數與按讚數都給**。所以這條線可以套完整的計分，
 * 不用像其他網站來源那樣把瀏覽與互動歸零。
 *
 * 憑證是官方文件公開的（client_credentials，任何人都用同一組），
 * 所以不放進設定檔，也沒有什麼好保護的。
 */

const YMGAL_BASE = 'https://www.ymgal.games'
const YMGAL_ID = 'ymgal'
const YMGAL_SECRET = 'luna0327'

/** 這個網域就走 API，不要去爬它的頁面 */
export function isYmgal(url: string): boolean {
  try {
    return /(^|\.)ymgal\.games$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

let cached: { token: string; expiresAt: number } | null = null

async function ymgalToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token
  const u = new URL(YMGAL_BASE + '/oauth/token')
  u.searchParams.set('grant_type', 'client_credentials')
  u.searchParams.set('client_id', YMGAL_ID)
  u.searchParams.set('client_secret', YMGAL_SECRET)
  u.searchParams.set('scope', 'public')

  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) {
    throw createError({ statusCode: res.status, message: 'ymgal 取 token 失敗：' + text.slice(0, 200) })
  }
  const d = JSON.parse(text) as { access_token?: string; expires_in?: number }
  if (!d.access_token) {
    throw createError({ statusCode: 502, message: 'ymgal 沒有回傳 token：' + text.slice(0, 200) })
  }
  // 提早 60 秒過期，免得剛好卡在邊界
  cached = {
    token: d.access_token,
    expiresAt: Date.now() + Math.max(60, (d.expires_in || 3600) - 60) * 1000
  }
  return cached.token
}

/**
 * publishTime 長這樣：`2026-08-31 20:09:30`，沒有時區。
 * 站在中國，所以當成 UTC+8 解 —— 直接丟給 Date.parse 會依執行機器的時區跑掉。
 */
export function parseYmgalTime(s: string): string {
  const raw = String(s || '').trim()
  // 已經標了時區（Z 或 +08:00）就照它的，不要再假設一次 ——
  // 不然帶 Z 的時間會被多減 8 小時，整整跑掉一天
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (!m || zoned) {
    const t = Date.parse(raw)
    return Number.isFinite(t) ? new Date(t).toISOString() : ''
  }
  // 沒標時區的（API 就是這種）當成 UTC+8，站在中國
  const [, y, mo, d, h, mi, sec] = m
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! - 8, +mi!, +sec!)).toISOString()
}

export interface YmgalTopic {
  topicId: string | number
  title: string
  introduction: string
  topicUrl: string
  mainImg: string
  publishTime: string
  views: number
  likesNum: number
  replyNum: number
  favoritesNum: number
  topicCategory: string
}

/** 把 API 的一則轉成跟 RSS 共用的格式，順便帶上互動數 */
export function ymgalToItem(t: YmgalTopic): FeedItem {
  return {
    title: String(t.title || '').trim(),
    link: String(t.topicUrl || '').trim(),
    postedAt: parseYmgalTime(t.publishTime),
    summary: String(t.introduction || '').trim().slice(0, 600),
    image: String(t.mainImg || '').trim(),
    categories: t.topicCategory ? [String(t.topicCategory)] : [],
    metrics: {
      views: Number(t.views) || 0,
      likes: Number(t.likesNum) || 0,
      // 這個站沒有「轉發」，收藏數的意義最接近，拿它頂替
      reposts: Number(t.favoritesNum) || 0,
      replies: Number(t.replyNum) || 0
    }
  }
}

/**
 * 讀最新消息。`資訊` 與 `專欄` 是兩個端點，都收 ——
 * 專欄多半是評論、企劃向的長文，對社群一樣有轉貼價值。
 */
export async function fetchYmgal(limit: number): Promise<FeedItem[]> {
  const token = await ymgalToken()
  const headers = {
    authorization: `Bearer ${token}`,
    version: '1',
    accept: 'application/json'
  }

  const out: FeedItem[] = []
  for (const path of ['/open/topic/news', '/open/topic/column']) {
    try {
      const res = await fetch(`${YMGAL_BASE}${path}?page=1`, {
        headers,
        signal: AbortSignal.timeout(30_000)
      })
      const text = await res.text()
      if (!res.ok) {
        logWarn('discover', `ymgal ${path} HTTP ${res.status}：${text.slice(0, 150)}`)
        continue
      }
      const d = JSON.parse(text) as {
        success?: boolean
        msg?: string
        data?: { result?: YmgalTopic[] } | YmgalTopic[]
      }
      if (!d.success) {
        logWarn('discover', `ymgal ${path} 回報失敗：${d.msg || text.slice(0, 150)}`)
        continue
      }
      const rows = Array.isArray(d.data) ? d.data : d.data?.result || []
      for (const t of rows) {
        const it = ymgalToItem(t)
        if (it.title && /^https?:\/\//i.test(it.link)) out.push(it)
      }
    } catch (e) {
      logWarn('discover', `ymgal ${path} 讀取失敗：${(e as Error).message}`)
    }
  }

  // 兩個端點合併之後照時間排，取前面幾則
  out.sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''))
  if (!out.length) {
    throw createError({ statusCode: 502, message: 'ymgal 讀不到任何消息' })
  }
  return out.slice(0, limit)
}
