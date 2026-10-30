import { promises as fs } from 'node:fs'
import { resolve, join } from 'node:path'
import { callPythonScript, findPython, toolPath } from './xscrape'

/**
 * Facebook／Instagram 走 Playwright（Python）+ 瀏覽器 profile 重用，
 * 跟 X 同一個路數，但兩邊是同一個 Meta 帳號體系，共用 data/.browser/meta 一份 profile。
 * 指令輸出是單行 JSON。
 */

export type SocialSite = 'fb' | 'ig'

export const SOCIAL_NAME: Record<SocialSite, string> = { fb: 'Facebook', ig: 'Instagram' }

const SCRIPT = 'social_scraper.py'

export interface SocialResult {
  url: string
  finalUrl: string
  site: SocialSite
  siteName: string
  text: string
  author: string
  handle: string
  createdAt: string
  images: string[]
  links: { url: string; label: string }[]
  downloaded: string[]
  loggedIn: boolean
  warning: string
  error?: string
  message?: string
}

/** 依碼位截斷，避免把 emoji 的 surrogate pair 切半（會產生非法 UTF-8） */
function cut(s: string, n: number): string {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('')
}

/** 網址屬於哪個站；都不是就回 null */
export function socialSite(url: string): SocialSite | null {
  let h = ''
  try {
    h = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
  if (h === 'facebook.com' || h === 'fb.com' || h === 'fb.watch' || h === 'fb.me' || h.endsWith('.facebook.com')) {
    return 'fb'
  }
  if (h === 'instagram.com' || h === 'instagr.am' || h.endsWith('.instagram.com')) return 'ig'
  return null
}

export function isSocialUrl(url: string): boolean {
  return socialSite(url) !== null
}

export function socialScriptPath(): string {
  return toolPath(SCRIPT)
}

export function socialProfileDir() {
  return resolve(process.cwd(), '..', 'data', '.browser', 'meta')
}
export function socialStateFile() {
  return resolve(process.cwd(), '..', 'data', '.browser', 'meta-state.json')
}

async function callScript(args: string[], timeout: number, signal?: AbortSignal) {
  const d = await callPythonScript(SCRIPT, args, timeout, signal)
  return d as unknown as SocialResult & {
    ready?: boolean
    loggedIn?: boolean | { fb?: boolean; ig?: boolean }
    downloaded?: string[]
    failed?: { url: string; reason: string }[]
  }
}

export interface SocialStatus {
  python: string | null
  scriptFound: boolean
  ready: boolean
  loggedIn: { fb: boolean; ig: boolean }
  profile: string
  checkedAt: string
  deep: boolean
  message: string
}

/**
 * 跟 X 一樣預設走快取檔（腳本每次執行都會寫），不開瀏覽器——
 * 開瀏覽器只為了查狀態既慢又會跟正在跑的抓取搶 profile。要真的驗證時才傳 deep=true。
 */
export async function socialStatus(deep = false): Promise<SocialStatus> {
  const py = await findPython()
  const sp = socialScriptPath()
  const scriptFound = await exists(sp)
  const base: SocialStatus = {
    python: py,
    scriptFound,
    ready: false,
    loggedIn: { fb: false, ig: false },
    profile: socialProfileDir(),
    checkedAt: '',
    deep: false,
    message: ''
  }
  if (!py || !scriptFound) {
    return { ...base, message: !py ? '找不到 Python' : `找不到 tools/${SCRIPT}` }
  }

  if (deep) {
    try {
      const d = await callScript(['--status'], 120_000)
      const got = (d.loggedIn || {}) as { fb?: boolean; ig?: boolean }
      return {
        ...base,
        ready: d.ready !== false,
        loggedIn: { fb: !!got.fb, ig: !!got.ig },
        profile: (d as { profile?: string }).profile || base.profile,
        checkedAt: new Date().toISOString(),
        deep: true,
        message: (d as { message?: string }).message || ''
      }
    } catch (e) {
      return { ...base, message: (e as { message?: string }).message || String(e) }
    }
  }

  const cached = await readJson<{ loggedIn?: { fb?: boolean; ig?: boolean }; at?: string }>(socialStateFile(), {})
  const hasProfile = await exists(socialProfileDir())
  return {
    ...base,
    ready: hasProfile,
    loggedIn: { fb: !!cached.loggedIn?.fb, ig: !!cached.loggedIn?.ig },
    checkedAt: cached.at || '',
    message: hasProfile ? '' : '還沒建立瀏覽器 profile'
  }
}

/** 開有頭瀏覽器讓使用者登入某一邊，最長等 10 分鐘 */
export async function socialLogin(site: SocialSite) {
  const d = await callScript(['--site', site, '--login'], 11 * 60_000)
  const got = (d.loggedIn || {}) as { fb?: boolean; ig?: boolean }
  return {
    loggedIn: { fb: !!got.fb, ig: !!got.ig },
    ok: !!got[site],
    profile: (d as { profile?: string }).profile || socialProfileDir(),
    message: d.message || ''
  }
}

export async function socialScrape(url: string, imagesDir?: string): Promise<SocialResult> {
  const site = socialSite(url)
  if (!site) throw createError({ statusCode: 400, message: '這不是 Facebook 或 Instagram 的網址' })
  const args = ['--url', url]
  if (imagesDir) args.push('--images-dir', imagesDir)
  const d = await callScript(args, 150_000)
  if (d.error) {
    throw createError({
      statusCode: 502,
      message: cut(String(d.message || d.error), 500) + (d.loggedIn ? '' : `（尚未登入 ${SOCIAL_NAME[site]}）`)
    })
  }
  return d
}

/** Meta 的圖片 CDN——直連被擋時要改走已登入的瀏覽器 context */
export function isMetaCdn(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h.endsWith('fbcdn.net') || h.endsWith('cdninstagram.com')
  } catch {
    return false
  }
}

async function socialDownload(urls: string[], imagesDir: string) {
  await fs.mkdir(imagesDir, { recursive: true })
  const args: string[] = ['--images-dir', imagesDir]
  for (const u of urls) args.push('--download', u)
  const d = await callScript(args, 120_000)
  return { downloaded: d.downloaded || [], failed: d.failed || [] }
}

/**
 * 備援下載：先讓 Playwright 存進暫存資料夾，再用一般的編號規則搬進目標資料夾。
 * 回傳最終檔名，跟直連下載的行為一致。
 */
export async function downloadViaSocial(urls: string[], destDir: string) {
  const tmp = join(destDir, '.meta-tmp-' + Date.now())
  const added: string[] = []
  const failed: { url: string; reason: string }[] = []
  try {
    const r = await socialDownload(urls, tmp)
    failed.push(...r.failed)
    await ensureDir(destDir)
    for (const f of r.downloaded as string[]) {
      const ext = f.slice(f.lastIndexOf('.'))
      const name = await nextImageName(destDir, ext)
      await fs.rename(join(tmp, f), join(destDir, name))
      added.push(name)
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  return { added, failed }
}

/** 把抓到的貼文轉成跟一般網頁抓取一致的形狀 */
export function toScrapeResultSocial(x: SocialResult) {
  const firstLine = (x.text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return {
    url: x.url,
    finalUrl: x.finalUrl || x.url,
    title: cut(firstLine, 60),
    description: x.text || '',
    siteName: x.siteName || SOCIAL_NAME[x.site] || '',
    sourceGuess: x.handle || x.author || x.siteName || '',
    images: x.images || [],
    links: x.links || [],
    warning: x.warning || '',
    via: 'playwright' as const,
    text: x.text || '',
    author: x.author || '',
    handle: x.handle || '',
    createdAt: x.createdAt || '',
    loggedIn: !!x.loggedIn
  }
}
