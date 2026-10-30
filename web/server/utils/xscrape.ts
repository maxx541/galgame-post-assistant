import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * X／Twitter 走 Playwright（Python）+ 瀏覽器 profile 重用，
 * 因為 X 對未登入的請求幾乎全擋。指令輸出是單行 JSON。
 */

export interface XResult {
  url: string
  finalUrl: string
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
  pageText?: string
}

/**
 * 依碼位截斷，避免把 emoji 的 surrogate pair 切半（會產生非法 UTF-8）。
 * 這裡自帶一份而不用 store.ts 的 auto-import 版本，是為了讓這個模組能被測試直接 import。
 */
function cut(s: string, n: number): string {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('')
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export function isXUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return h === 'x.com' || h === 'twitter.com' || h === 'mobile.twitter.com'
  } catch {
    return false
  }
}

export function toolPath(file: string): string {
  return resolve(process.cwd(), '..', 'tools', file)
}

export function scriptPath(): string {
  return toolPath('x_scraper.py')
}

/** Windows 上優先用 py launcher，其餘平台用 python3／python */
const CANDIDATES = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']

let cachedPython: string | null = null

/**
 * 同一份 user_data_dir 不能被兩個 Chromium 同時開啟，
 * 否則第二個會拿到半殘的 session（實測會卡在 loading spinner）。
 * 每支腳本各有一條佇列（profile 不同，彼此不衝突），同一支一次只跑一個。
 */
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn)
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

async function run(cmd: string, args: string[], timeout: number, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(res => {
    execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
        // 按停止時直接砍掉這個行程，不用等它跑完
        ...(signal ? { signal } : {})
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err.code as number) : err ? 1 : 0
        res({ code, stdout: stdout || '', stderr: stderr || '' })
      }
    )
  })
}

export async function findPython(): Promise<string | null> {
  if (cachedPython) return cachedPython
  for (const c of CANDIDATES) {
    const r = await run(c, ['--version'], 15_000)
    if (r.code === 0 || /Python \d/.test(r.stdout + r.stderr)) {
      cachedPython = c
      return c
    }
  }
  return null
}

function parseOut(stdout: string, stderr: string, code: number) {
  const t = stdout.trim()
  if (!t) {
    throw createError({
      statusCode: 502,
      message: 'Playwright 腳本沒有輸出（exit ' + code + '）：' + stderr.trim().slice(0, 400)
    })
  }
  // stdout 只會有那一行 JSON，但保險起見從最後一個 { 開始找
  const start = t.indexOf('{')
  try {
    return JSON.parse(t.slice(start === -1 ? 0 : start))
  } catch {
    throw createError({ statusCode: 502, message: '腳本輸出不是合法 JSON：' + t.slice(0, 300) })
  }
}

/**
 * 跑 tools/ 底下的某支 Playwright 腳本並解析它印出的單行 JSON。
 * x 與 Facebook／Instagram 兩支腳本共用這裡的 Python 偵測、佇列與錯誤處理。
 */
export async function callPythonScript(
  file: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const py = await findPython()
  if (!py) {
    throw createError({
      statusCode: 500,
      message: '找不到 Python。安裝 Python 3.10 以上，再執行：py -m pip install playwright、py -m playwright install chromium'
    })
  }
  const sp = toolPath(file)
  if (!(await exists(sp))) {
    throw createError({ statusCode: 500, message: `找不到 tools/${file}：` + sp })
  }
  if (signal?.aborted) throw createError({ statusCode: 499, message: '已停止' })
  const r = await serialize(file, () => run(py, [sp, ...args], timeout, signal))
  if (signal?.aborted) throw createError({ statusCode: 499, message: '已停止' })
  return parseOut(r.stdout, r.stderr, r.code)
}

async function callScript(args: string[], timeout: number, signal?: AbortSignal) {
  const data = await callPythonScript('x_scraper.py', args, timeout, signal)
  return data as unknown as XResult & {
    ready?: boolean
    downloaded?: string[]
    failed?: { url: string; reason: string }[]
  }
}

export function profileDir() {
  return resolve(process.cwd(), '..', 'data', '.browser', 'x')
}
export function stateFile() {
  return resolve(process.cwd(), '..', 'data', '.browser', 'x-state.json')
}

export interface XStatus {
  python: string | null
  scriptFound: boolean
  ready: boolean
  loggedIn: boolean
  profile: string
  checkedAt: string
  deep: boolean
  message: string
}

/**
 * 預設走快取檔（腳本每次執行都會寫），不開瀏覽器 —— 開瀏覽器只為了查狀態
 * 既慢又會跟正在跑的抓取搶 profile。要真的驗證時才傳 deep=true。
 */
export async function xStatus(deep = false): Promise<XStatus> {
  const py = await findPython()
  const sp = scriptPath()
  const scriptFound = await exists(sp)
  const base: XStatus = {
    python: py,
    scriptFound,
    ready: false,
    loggedIn: false,
    profile: profileDir(),
    checkedAt: '',
    deep: false,
    message: ''
  }
  if (!py || !scriptFound) {
    return { ...base, message: !py ? '找不到 Python' : '找不到 tools/x_scraper.py' }
  }

  if (deep) {
    try {
      const d = await callScript(['--status'], 120_000)
      return {
        ...base,
        ready: d.ready !== false,
        loggedIn: !!d.loggedIn,
        profile: (d as { profile?: string }).profile || base.profile,
        checkedAt: new Date().toISOString(),
        deep: true,
        message: (d as { message?: string }).message || ''
      }
    } catch (e) {
      return { ...base, message: (e as { message?: string }).message || String(e) }
    }
  }

  const cached = await readJson<{ loggedIn?: boolean; at?: string }>(stateFile(), {})
  const hasProfile = await exists(profileDir())
  return {
    ...base,
    ready: hasProfile,
    loggedIn: !!cached.loggedIn,
    checkedAt: cached.at || '',
    message: hasProfile ? '' : '還沒建立瀏覽器 profile'
  }
}

/** 開有頭瀏覽器讓使用者登入，最長等 10 分鐘 */
export async function xLogin() {
  return await callScript(['--login'], 11 * 60_000)
}

export async function xScrape(url: string, imagesDir?: string): Promise<XResult> {
  const args = ['--url', url]
  if (imagesDir) args.push('--images-dir', imagesDir)
  const d = await callScript(args, 120_000)
  if (d.error) {
    throw createError({
      statusCode: 502,
      message: cut(String(d.message || d.error), 500) + (d.loggedIn ? '' : '（尚未登入 X）')
    })
  }
  return d
}

export interface TimelineTweet {
  id: string
  /** 搜尋模式才有：這則是誰發的 */
  handle?: string
  url: string
  text: string
  postedAt: string
  images: string[]
  links: { url: string; label: string }[]
  metrics: { replies: number; reposts: number; likes: number; views: number }
  isRepost: boolean
  isReply: boolean
  isPinned: boolean
}

/**
 * 讀一個帳號時間軸最新 N 則。走既有的 serialize 佇列，
 * 不會跟其他 Chromium 搶同一份 profile。
 */
export async function xTimeline(handle: string, limit = 10, signal?: AbortSignal): Promise<{
  handle: string
  loggedIn: boolean
  tweets: TimelineTweet[]
  warning: string
}> {
  const h = String(handle || '').replace(/^@/, '').trim()
  if (!h) throw createError({ statusCode: 400, message: '要給帳號名' })
  const d = (await callScript(
    ['--timeline', h, '--limit', String(Math.max(1, Math.min(limit, 40)))],
    150_000,
    signal
  )) as unknown as {
    handle: string
    loggedIn: boolean
    tweets?: TimelineTweet[]
    warning?: string
    error?: string
    message?: string
  }
  if (d.error) {
    throw createError({
      statusCode: 502,
      message: cut(String(d.message || d.error), 400) + (d.loggedIn ? '' : '（尚未登入 X）')
    })
  }
  return {
    handle: d.handle || h,
    loggedIn: !!d.loggedIn,
    tweets: Array.isArray(d.tweets) ? d.tweets : [],
    warning: d.warning || ''
  }
}

/**
 * 用關鍵字搜 X 的熱門推文。只在「收錄素材時網頁抓不到圖」才會走這條，
 * 目的是找官方帳號發的主視覺圖，不是拿來當素材來源。
 *
 * 跟 xTimeline 一樣走既有的 profile 佇列（callScript），不會另外開瀏覽器。
 * 搜尋失敗回空陣列而不是丟例外——這只是備援，不該讓收錄整個失敗。
 */
export async function xSearch(query: string, limit = 8): Promise<TimelineTweet[]> {
  const q = String(query || '').trim()
  if (!q) return []
  try {
    const d = (await callScript(
      ['--search', q, '--limit', String(Math.max(1, Math.min(limit, 20)))],
      150_000
    )) as unknown as { tweets?: TimelineTweet[]; error?: string }
    if (d.error) return []
    return Array.isArray(d.tweets) ? d.tweets : []
  } catch {
    return []
  }
}

/** pbs.twimg.com 直連失敗時的備援：用已登入的瀏覽器 context 下載 */
export async function xDownload(urls: string[], imagesDir: string) {
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
export async function downloadViaX(urls: string[], destDir: string) {
  const tmp = join(destDir, '.x-tmp-' + Date.now())
  const added: string[] = []
  const failed: { url: string; reason: string }[] = []
  try {
    const r = await xDownload(urls, tmp)
    failed.push(...r.failed)
    await ensureDir(destDir)
    for (let i = 0; i < r.downloaded.length; i++) {
      const f = r.downloaded[i] as string
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

/**
 * t.co 不是 301，而是回 200 帶 <meta http-equiv="refresh"> 與 <title>，
 * 所以要自己把真正的網址挖出來。挖不到就原樣回傳。
 */
export async function expandTco(url: string): Promise<string> {
  if (!/^https?:\/\/t\.co\//i.test(url)) return url
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000)
    })
    if (r.url && !/t\.co\//i.test(r.url)) return r.url
    const html = await r.text()
    const meta = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*URL=([^"']+)["']/i)?.[1]
    if (meta) return meta.trim()
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
    if (title && /^https?:\/\//i.test(title)) return title
  } catch {
    /* 展不開就用原本的 t.co，照樣點得進去 */
  }
  return url
}

/** X 上的顯示文字是被截斷的網址，拿來當標籤很醜，改用網域 */
function labelFor(url: string, raw: string): string {
  const t = (raw || '').trim()
  if (t && !t.includes('…') && !/^[\w.-]+\.\w+\//.test(t) && !/^https?:/.test(t)) return t
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export async function expandLinks(links: { url: string; label: string }[]) {
  const out: { url: string; label: string }[] = []
  const seen = new Set<string>()
  for (const l of links.slice(0, 8)) {
    const url = await expandTco(l.url)
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, label: labelFor(url, l.label) })
  }
  return out
}

export function isTwimg(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('twimg.com')
  } catch {
    return false
  }
}

/** 把 Playwright 抓到的推文轉成跟一般網頁抓取一致的形狀 */
export function toScrapeResult(x: XResult) {
  const firstLine = (x.text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return {
    url: x.url,
    finalUrl: x.finalUrl || x.url,
    title: cut(firstLine, 60),
    description: x.text || '',
    siteName: 'X',
    sourceGuess: x.handle || x.author || 'X',
    images: x.images || [],
    links: x.links || [],
    warning: x.warning || (x.loggedIn ? '' : '目前未登入 X，抓到的內容可能不完整'),
    via: 'playwright' as const,
    text: x.text || '',
    author: x.author || '',
    handle: x.handle || '',
    createdAt: x.createdAt || '',
    loggedIn: !!x.loggedIn
  }
}

export const joinPath = join
