import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, extFromType, nextImageName, IMAGE_EXT } from './store'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface ScrapeResult {
  url: string
  finalUrl: string
  title: string
  description: string
  siteName: string
  /** 推測的來源名稱／帳號，可直接填進（來源：…） */
  sourceGuess: string
  images: string[]
  /** og:image／twitter:image 這類站方自己指定的代表圖，是 images 的子集 */
  heroImages: string[]
  /** 文章發佈時間（ISO）。抓不到就空的 —— 計分時要靠它算時效 */
  publishedAt: string
  warning: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function metaContent(html: string, keys: string[]): string {
  for (const key of keys) {
    const re = new RegExp(
      '<meta[^>]+(?:property|name)\\s*=\\s*["\']' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>',
      'i'
    )
    const tag = html.match(re)?.[0]
    if (!tag) continue
    const c = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1]
    if (c) return decodeEntities(c.trim())
  }
  return ''
}

function metaAll(html: string, key: string): string[] {
  const re = new RegExp(
    '<meta[^>]+(?:property|name)\\s*=\\s*["\']' + key + '["\'][^>]*content\\s*=\\s*["\']([^"\']+)["\']',
    'gi'
  )
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push(decodeEntities(m[1]!.trim()))
  const re2 = new RegExp(
    '<meta[^>]+content\\s*=\\s*["\']([^"\']+)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + key + '["\']',
    'gi'
  )
  while ((m = re2.exec(html))) out.push(decodeEntities(m[1]!.trim()))
  return out
}

function absolutize(u: string, base: string): string | null {
  try {
    return new URL(u, base).toString()
  } catch {
    return null
  }
}

function guessSource(finalUrl: string, siteName: string, html: string): string {
  try {
    const h = new URL(finalUrl).hostname.replace(/^www\./, '')
    if (/twitter\.com|x\.com/.test(h)) {
      const handle = new URL(finalUrl).pathname.split('/').filter(Boolean)[0]
      if (handle) return '@' + handle
    }
    if (/threads\.net|threads\.com/.test(h)) {
      const seg = new URL(finalUrl).pathname.split('/').filter(Boolean)[0]
      if (seg?.startsWith('@')) return seg
    }
    if (/store\.steampowered\.com/.test(h)) {
      const dev = html.match(/<div[^>]*id=["']developers_list["'][^>]*>([\s\S]{0,300}?)<\/div>/i)?.[1]
      const name = dev?.match(/>([^<]+)</)?.[1]?.trim()
      if (name) return name
      return 'Steam'
    }
    return siteName || h
  } catch {
    return siteName
  }
}

/**
 * 日系成人向網站的年齡確認閘。
 *
 * 這些站沒帶 cookie 的話回的是「年齢認証ページ」而不是商品頁 ——
 * 實測 getchu 的商品頁，沒帶 cookie 只看得到 4 張圖（都是介面元件），
 * 帶了之後是 29 張、標題才是真的作品名。對 galgame 情報來說這幾個站是主力來源，
 * 不處理等於整類連結都抓不到東西。
 */
const AGE_COOKIES: { test: RegExp; cookie: string }[] = [
  { test: /(^|\.)getchu\.com$/i, cookie: 'getchu_adalt_flag=getchu.com' },
  { test: /(^|\.)dlsite\.com$/i, cookie: 'adultchecked=1' },
  { test: /(^|\.)(dmm\.co\.jp|dmm\.com)$/i, cookie: 'age_check_done=1' },
  { test: /(^|\.)melonbooks\.co\.jp$/i, cookie: 'AUTH_ADULT=1' }
]

export function ageCookieFor(url: string): string {
  try {
    const host = new URL(url).hostname
    return AGE_COOKIES.find(x => x.test.test(host))?.cookie || ''
  } catch {
    return ''
  }
}

/**
 * 依 Content-Type 或 meta 標籤決定編碼再解字串。
 *
 * 直接 res.text() 一律當 UTF-8，遇到 getchu 這種 EUC-JP 的站，
 * 標題會整串變亂碼，然後被拿去當素材標題和資料夾名。
 */
export function decodeBody(buf: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder('utf-8').decode(new Uint8Array(buf).subarray(0, 2048))
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1]
  const enc = (fromHeader || fromMeta || 'utf-8').toLowerCase()
  try {
    return new TextDecoder(enc).decode(buf)
  } catch {
    // 認不得的編碼就退回 UTF-8，總比整個失敗好
    return new TextDecoder('utf-8').decode(buf)
  }
}

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  const cookie = ageCookieFor(url)
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7',
      ...(cookie ? { cookie } : {})
    },
    redirect: 'follow'
  })
  const finalUrl = res.url || url
  const html = decodeBody(await res.arrayBuffer(), res.headers.get('content-type') || '')

  const title = metaContent(html, ['og:title', 'twitter:title']) || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '')
  const description = metaContent(html, ['og:description', 'twitter:description', 'description'])
  const siteName = metaContent(html, ['og:site_name'])

  const raw = [
    ...metaAll(html, 'og:image:secure_url'),
    ...metaAll(html, 'og:image'),
    ...metaAll(html, 'twitter:image'),
    ...metaAll(html, 'twitter:image:src')
  ]
  const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)?.[1]
  if (linkImg) raw.push(decodeEntities(linkImg))
  // 上面這些是站方自己指定的分享圖，選圖時要優先；後面補的 <img> 不算
  const heroRaw = [...raw]

  // 補抓頁面內較大的 <img>（排除 icon/logo/avatar/1x1）
  const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  let count = 0
  while ((m = imgRe.exec(html)) && count < 40) {
    const src = decodeEntities(m[1]!)
    if (/icon|logo|avatar|sprite|spacer|blank|pixel|1x1|badge|emoji|hamburger|arrow|btn_|button|placeholder|\/public\/shared\//i.test(src)) continue
    if (src.startsWith('data:')) continue
    raw.push(src)
    count++
  }

  const seen = new Set<string>()
  const images: string[] = []
  for (const r of raw) {
    const abs = absolutize(r, finalUrl)
    if (!abs || seen.has(abs)) continue
    seen.add(abs)
    images.push(abs)
    if (images.length >= 24) break
  }

  let warning = ''
  const host = (() => {
    try {
      return new URL(finalUrl).hostname
    } catch {
      return ''
    }
  })()
  if (/twitter\.com|x\.com|threads\.net|threads\.com|instagram\.com|facebook\.com/.test(host) && images.length === 0) {
    warning = '這個平台有登入牆／反爬，通常抓不到圖。到設定頁登入 X／Facebook／Instagram 可以改善，或直接拖曳、Ctrl+V 貼上圖片。'
  }

  // 時效分數要靠這個。三種常見寫法都試：Open Graph、schema.org、<time datetime>
  const published =
    metaContent(html, ['article:published_time', 'og:published_time', 'article:modified_time']) ||
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ||
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1] ||
    ''
  const publishedAt = (() => {
    const t = Date.parse(decodeEntities(published || '').trim())
    return Number.isFinite(t) ? new Date(t).toISOString() : ''
  })()

  const heroSeen = new Set<string>()
  const heroImages: string[] = []
  for (const r of heroRaw) {
    const abs = absolutize(r, finalUrl)
    if (!abs || heroSeen.has(abs)) continue
    heroSeen.add(abs)
    heroImages.push(abs)
  }

  return {
    url,
    finalUrl,
    title,
    description,
    siteName,
    sourceGuess: guessSource(finalUrl, siteName, html),
    images,
    heroImages,
    publishedAt,
    warning
  }
}

export async function downloadImage(url: string, destDir: string, referer = ''): Promise<string> {
  // 年齡閘的站連圖片也會擋，cookie 要一起帶
  const cookie = ageCookieFor(url) || ageCookieFor(referer)
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'image/*,*/*',
      ...(referer ? { referer } : {}),
      ...(cookie ? { cookie } : {})
    }
  })
  if (!res.ok) throw new Error('下載失敗 HTTP ' + res.status)
  const type = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error('圖片太小，可能不是有效圖片')
  await ensureDir(destDir)
  const name = await nextImageName(destDir, extFromType(type, url))
  await fs.writeFile(join(destDir, name), buf)
  return name
}

export function isImageFilename(name: string) {
  const i = name.lastIndexOf('.')
  return i > 0 && IMAGE_EXT.has(name.slice(i).toLowerCase())
}
