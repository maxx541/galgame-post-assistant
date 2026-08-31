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

/** 撰寫完成後，把素材連同圖片轉成一則貼文 */
export async function createPostFromMaterial(
  m: Material,
  meta: { title: string; category: string; postType: string; missing: string[]; sourceName: string }
) {
  await ensureDir(postsDir())
  const postId = await uniqueId(postsDir(), todayStamp() + '-' + slugify(sliceChars(meta.title, 24)))
  const dst = join(postsDir(), postId)
  await ensureDir(join(dst, 'variants'))
  await ensureDir(join(dst, 'images'))

  const post = emptyMeta(postId, meta.title)
  post.category = meta.category
  post.postType = meta.postType
  post.missing = meta.missing
  post.sourceName = meta.sourceName || m.sourceGuess
  post.sourceUrl = m.finalUrl || m.url
  post.platforms = m.platforms.length ? m.platforms : ['facebook']
  post.note = m.text
  post.status = meta.missing.length ? 'needs-info' : 'draft'
  // 留言區放的是內容裡的導流連結，不是素材本身的網址
  post.links = (m.links || []).filter(l => l.url?.trim()).map(l => ({ label: l.label || '', url: l.url.trim() }))

  for (const f of m.images) {
    const from = join(inboxDir(), m.id, 'images', f)
    if (!(await exists(from))) continue
    const name = await nextImageName(join(dst, 'images'), f.slice(f.lastIndexOf('.')))
    await fs.copyFile(from, join(dst, 'images', name))
    post.images.push({ file: name, artist: '', alt: '', sourceUrl: m.finalUrl || m.url, selected: true })
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
