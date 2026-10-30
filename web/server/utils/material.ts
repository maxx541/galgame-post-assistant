import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 素材：從網址抓下來的原始內容，還沒寫成文案。
 * 一則素材 = 一個資料夾（material.json + images/）。
 */
export interface Material {
  id: string
  /** 抓到的標題，只是給人看的；真正的貼文標題由 AI 判斷 */
  title: string
  url: string
  finalUrl: string
  /** 原始貼文全文，保留原始換行。這是撰寫時的主要依據 */
  text: string
  author: string
  handle: string
  /** 原文發佈時間（推特有，一般網頁多半沒有） */
  postedAt: string
  sourceGuess: string
  /** playwright | fetch | manual */
  via: string
  /** 要寫給哪些平台，在素材階段就決定 */
  platforms: string[]
  /** 撰寫時附加的指示 */
  extra: string
  images: string[]
  /**
   * 要放到留言的導流連結——是「內容裡面提到的連結」，不是這則素材本身的網址。
   * 推文就是推文內文裡的外連；一般網頁則預設用該頁網址。可以自己編輯。
   */
  links: { url: string; label: string }[]
  /** 抓取階段的問題，例如未登入、被擋 */
  warning: string
  written: boolean
  /** 撰寫完成後產生的貼文 id */
  postId: string
  addedAt: string
}

export function emptyMaterial(id: string, url = ''): Material {
  return {
    id,
    title: '',
    url,
    finalUrl: url,
    text: '',
    author: '',
    handle: '',
    postedAt: '',
    sourceGuess: '',
    via: 'manual',
    platforms: ['facebook'],
    extra: '',
    images: [],
    links: [],
    warning: '',
    written: false,
    postId: '',
    addedAt: new Date().toISOString()
  }
}

export function materialPath(id: string) {
  return join(inboxDir(), safeSegment(id), 'material.json')
}

export async function loadMaterial(id: string): Promise<Material | null> {
  const p = materialPath(id)
  if (!(await exists(p))) return null
  const m = await readJson<Partial<Material>>(p, {})
  return { ...emptyMaterial(id), ...m, id }
}

export async function saveMaterial(m: Material) {
  await writeJson(materialPath(m.id), m)
}

export async function listMaterials(): Promise<Material[]> {
  const dir = inboxDir()
  await ensureDir(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: Material[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = await loadMaterial(e.name)
    if (m) out.push(m)
  }
  out.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
  return out
}

/** 從標題或原文開頭生一個好認的資料夾名 */
export function materialSlugBase(title: string, text: string, url: string) {
  const first = (title || '').trim() || (text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  if (first) return todayStamp() + '-' + slugify(sliceChars(first, 24))
  try {
    return todayStamp() + '-' + slugify(new URL(url).hostname.replace(/^www\./, ''))
  } catch {
    return todayStamp() + '-素材'
  }
}

/** 合併撰寫時，每則素材只帶前幾張圖進貼文，免得幾則素材的圖全部堆在一起 */
export const MERGE_IMAGES_PER_MATERIAL = 3
/** IG 輪播一次最多 10 張，超過的圖先不勾，要用再自己勾 */
const MAX_SELECTED_IMAGES = 10

export function materialToSource(m: Material): PostSource {
  return {
    materialId: m.id,
    title: m.title,
    url: m.finalUrl || m.url,
    sourceName: m.sourceGuess || m.handle || m.author,
    author: m.author,
    postedAt: m.postedAt,
    text: m.text
  }
}

/**
 * 多則素材的原文串成一段，存進 post.note 給人看、給 preview.py 讀。
 * 只有一則時就是原文本身，跟以前一樣。
 */
export function joinSourceTexts(sources: PostSource[]): string {
  if (sources.length === 1) return sources[0]!.text
  return sources
    .map((s, i) => {
      const lines = [`【素材 ${i + 1}${i === 0 ? '・主要' : ''}】${s.title || s.sourceName || ''}`]
      if (s.url) lines.push(s.url)
      lines.push('', s.text.trim())
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * 撰寫完成後，把素材連同圖片轉成一則貼文。
 * 傳多則就是合併撰寫：第一則是主素材，來源欄位取它的；
 * 圖片每則只帶前 MERGE_IMAGES_PER_MATERIAL 張，依素材順序排。
 */
export async function createPostFromMaterials(
  ms: Material[],
  meta: { title: string; category: string; postType: string; missing: string[]; sourceName: string },
  platforms: string[]
) {
  const main = ms[0]
  if (!main) throw createError({ statusCode: 400, message: '沒有素材' })
  const merged = ms.length > 1

  await ensureDir(postsDir())
  const postId = await uniqueId(postsDir(), todayStamp() + '-' + slugify(sliceChars(meta.title, 24)))
  const dst = join(postsDir(), postId)
  await ensureDir(join(dst, 'variants'))
  await ensureDir(join(dst, 'images'))

  const post = emptyMeta(postId, meta.title)
  post.category = meta.category
  post.postType = meta.postType
  post.missing = meta.missing
  post.sourceName = meta.sourceName || main.sourceGuess
  post.sourceUrl = main.finalUrl || main.url
  post.sources = ms.map(materialToSource)
  post.platforms = platforms.length ? platforms : ['facebook']
  post.note = joinSourceTexts(post.sources)
  post.status = meta.missing.length ? 'needs-info' : 'draft'
  // 留言區放的是內容裡的導流連結，不是素材本身的網址
  const seen = new Set<string>()
  for (const m of ms) {
    for (const l of m.links || []) {
      const url = l.url?.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      post.links.push({ label: l.label || '', url })
    }
  }

  for (const m of ms) {
    const files = merged ? m.images.slice(0, MERGE_IMAGES_PER_MATERIAL) : m.images
    for (const f of files) {
      const from = join(inboxDir(), m.id, 'images', f)
      if (!(await exists(from))) continue
      const name = await nextImageName(join(dst, 'images'), f.slice(f.lastIndexOf('.')))
      await fs.copyFile(from, join(dst, 'images', name))
      post.images.push({
        file: name,
        artist: '',
        alt: '',
        sourceUrl: m.finalUrl || m.url,
        selected: !merged || post.images.length < MAX_SELECTED_IMAGES
      })
    }
  }
  await savePostMeta(post)
  return postId
}

/** 把一串文字裡的 http(s) 網址全部挑出來，去重 */
export function extractUrls(text: string): string[] {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'）)、，,。！？；：「」【】]+/g) || []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of found) {
    const u = raw.replace(/[.,;:!?]+$/, '')
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

/**
 * 刪掉一則貼文（整個資料夾連圖片），並把收尾做完：
 * - 寫出這篇的素材若還在，改回「未撰寫」，可以重寫
 * - 這篇還沒發的本機排程取消掉，免得到時候找不到貼文一直報錯
 * 回傳刪掉的位元組數；貼文不存在回 -1。
 */
export async function deletePost(id: string): Promise<number> {
  const dir = join(postsDir(), safeSegment(id))
  if (!(await exists(dir))) return -1
  const bytes = await dirSize(dir)
  await fs.rm(dir, { recursive: true, force: true })

  for (const m of await listMaterials()) {
    if (m.postId !== id) continue
    m.written = false
    m.postId = ''
    await saveMaterial(m)
  }

  const items = await loadSchedule()
  let touched = false
  for (const it of items) {
    if (it.postId === id && it.status === 'pending') {
      it.status = 'cancelled'
      it.error = '貼文已刪除'
      it.doneAt = new Date().toISOString()
      touched = true
    }
  }
  if (touched) await saveSchedule(items)
  return bytes
}
