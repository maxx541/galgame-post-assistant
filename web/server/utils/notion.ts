import { join } from 'node:path'

/**
 * Notion 來源：讀「日本 Galgame 行业日报 文案版」那種每日彙整頁。
 *
 * 頁面結構非常規則，每則情報固定三個段落 + 一個空行：
 *   1. 內容摘要
 *   2. YYYY-MM-DD ｜ 廠商（作品）
 *   3. 原始連結（帶 href）
 * 解析就是「用空行分組，組內用格式辨認哪行是什麼」，不靠行的順序。
 */

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

export interface NotionSettings {
  token: string
  enabled: boolean
  /** 只看標題含這個字的頁（空字串表示不過濾） */
  titleFilter: string
  /** 一次最多讀幾天份的頁 */
  maxPages: number
  /** 日報自己的排程，跟推特抓取分開 —— 它幾秒就跑完，可以跑得比 X 勤 */
  autoRun: boolean
  intervalHours: number
  lastRunAt: string
  /** 收進來的候選要不要走自動收錄門檻。預設 false —— 日報是人工整理過的，
   *  一天十幾則自己挑比較快，不需要自動灌進素材夾 */
}

export function defaultNotionSettings(): NotionSettings {
  return { token: '', enabled: false, titleFilter: '文案版', maxPages: 3, autoRun: false, intervalHours: 6, lastRunAt: '' }
}

export async function loadNotionSettings(): Promise<NotionSettings> {
  const all = await readJson<{ notion?: Partial<NotionSettings> }>(join(dataDir(), 'settings.json'), {})
  return { ...defaultNotionSettings(), ...(all.notion || {}) }
}

export async function saveNotionSettings(n: Partial<NotionSettings>) {
  const p = join(dataDir(), 'settings.json')
  const all = await readJson<Record<string, unknown>>(p, {})
  const cur = { ...defaultNotionSettings(), ...((all.notion as Partial<NotionSettings>) || {}) }
  await writeJson(p, { ...all, notion: { ...cur, ...n } })
  return await loadNotionSettings()
}

// ── API ───────────────────────────────────────────────────────────
async function notionApi(token: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${NOTION_API}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000)
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 300)
    try {
      msg = JSON.parse(text)?.message || msg
    } catch {
      /* 不是 JSON 就用原文 */
    }
    throw createError({
      statusCode: res.status === 401 ? 401 : 502,
      message: `Notion：${msg}${res.status === 404 ? '（頁面沒有分享給這個 integration？）' : ''}`
    })
  }
  return JSON.parse(text)
}

export interface NotionPageRef {
  id: string
  title: string
  editedAt: string
}

function titleOf(o: Record<string, unknown>): string {
  const props = (o.properties || {}) as Record<string, { type?: string; title?: { plain_text?: string }[] }>
  for (const v of Object.values(props)) {
    if (v?.type === 'title') return (v.title || []).map(t => t.plain_text || '').join('')
  }
  return ''
}

/** 列出這個 integration 看得到、標題符合條件的頁 */
export async function listDigestPages(s: NotionSettings): Promise<NotionPageRef[]> {
  const d = await notionApi(s.token, 'search', 'POST', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 50
  })
  const out: NotionPageRef[] = []
  for (const o of (d.results || []) as Record<string, unknown>[]) {
    const title = titleOf(o)
    if (s.titleFilter && !title.includes(s.titleFilter)) continue
    out.push({ id: String(o.id), title, editedAt: String(o.last_edited_time || '') })
  }
  // 標題裡有日期就照日期排，沒有就照編輯時間
  out.sort((a, b) => (dateInTitle(b.title) || b.editedAt).localeCompare(dateInTitle(a.title) || a.editedAt))
  return out
}

export function dateInTitle(title: string): string {
  return String(title || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] || ''
}

async function allBlocks(token: string, pageId: string) {
  const out: Record<string, unknown>[] = []
  let cursor = ''
  for (let i = 0; i < 20; i++) {
    const q = `blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    const d = await notionApi(token, q)
    out.push(...((d.results || []) as Record<string, unknown>[]))
    if (!d.has_more) break
    cursor = String(d.next_cursor || '')
    if (!cursor) break
  }
  return out
}

// ── 解析（純函式，可以直接被測試 import）─────────────────────────
export interface RichLine {
  text: string
  href: string
}

/** 把 Notion 區塊壓成「文字 + 連結」的扁平行 */
export function blockToLine(b: Record<string, unknown>): RichLine {
  const type = String(b.type || '')
  const c = (b[type] || {}) as { rich_text?: { plain_text?: string; href?: string }[] }
  const rich = c.rich_text || []
  return {
    text: rich.map(x => x.plain_text || '').join('').trim(),
    href: rich.find(x => x.href)?.href || ''
  }
}

/** `2026-08-30 ｜ AQUAPLUS（WHITE ALBUM2）` 這種行 */
export const META_RE = /^(\d{4}-\d{2}-\d{2})\s*[｜|]\s*(.+)$/

export interface NotionEntry {
  /** 用原始連結當去重主鍵 */
  id: string
  text: string
  date: string
  /** 廠商，可能帶括號的作品名 */
  source: string
  work: string
  url: string
}

/** 廠商（作品）→ 拆成兩段 */
export function splitSource(raw: string): { source: string; work: string } {
  const m = String(raw || '').trim().match(/^(.*?)[（(]([^）)]+)[）)]\s*$/)
  if (m) return { source: (m[1] || '').trim(), work: (m[2] || '').trim() }
  return { source: String(raw || '').trim(), work: '' }
}

/**
 * 用空行把區塊分組，組內靠格式辨認哪行是什麼——
 * 不假設行的順序，內容多行也接得住。
 */
export function parseDigest(lines: RichLine[]): NotionEntry[] {
  const groups: RichLine[][] = []
  let cur: RichLine[] = []
  for (const l of lines) {
    if (!l.text) {
      if (cur.length) groups.push(cur)
      cur = []
      continue
    }
    cur.push(l)
  }
  if (cur.length) groups.push(cur)

  const out: NotionEntry[] = []
  for (const g of groups) {
    const metaLine = g.find(l => META_RE.test(l.text))
    const urlLine = g.find(l => l.href || /^https?:\/\//i.test(l.text))
    const body = g
      .filter(l => l !== metaLine && l !== urlLine)
      .map(l => l.text)
      .join('\n')
      .trim()
    if (!body) continue

    const m = metaLine ? META_RE.exec(metaLine.text) : null
    const { source, work } = splitSource(m?.[2] || '')
    const url = urlLine ? urlLine.href || urlLine.text : ''
    out.push({
      id: url || body.slice(0, 60),
      text: body,
      date: m?.[1] || '',
      source,
      work,
      url
    })
  }
  return out
}

/** 讀最近幾天的日報，回傳所有情報條目 */
export async function fetchDigestEntries(s: NotionSettings) {
  if (!s.token) throw createError({ statusCode: 400, message: '還沒設定 Notion token' })
  const pages = (await listDigestPages(s)).slice(0, Math.max(1, s.maxPages))
  const entries: (NotionEntry & { pageTitle: string })[] = []
  for (const p of pages) {
    const lines = (await allBlocks(s.token, p.id)).map(blockToLine)
    for (const e of parseDigest(lines)) entries.push({ ...e, pageTitle: p.title })
  }
  return { pages, entries }
}

/** 連線測試：看得到哪些頁、最新一頁解析出幾則 */
export async function testNotion(s: NotionSettings) {
  const pages = await listDigestPages(s)
  let sample: NotionEntry[] = []
  if (pages.length) {
    const lines = (await allBlocks(s.token, pages[0]!.id)).map(blockToLine)
    sample = parseDigest(lines)
  }
  return {
    pageCount: pages.length,
    pages: pages.slice(0, 8).map(p => ({ title: p.title, date: dateInTitle(p.title) })),
    sampleTitle: pages[0]?.title || '',
    sampleCount: sample.length,
    sample: sample.slice(0, 3)
  }
}
