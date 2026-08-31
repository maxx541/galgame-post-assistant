import { promises as fs } from 'node:fs'
import { resolve, join, extname, basename } from 'node:path'

export interface PostImage {
  file: string
  artist: string
  alt: string
  sourceUrl: string
  selected: boolean
}

export interface PostLink {
  label: string
  url: string
}

export interface PublishRecord {
  platform: string
  at: string
  url: string
  /** now 立即 / draft 未發佈貼文 / schedule 排程 */
  mode?: string
  /** 平台端的貼文 id */
  externalId?: string
  variantId?: string
  /** 排程的發佈時間 */
  scheduledAt?: string
  /** 還沒貼的留言文字（未發佈與排程時貼文尚未公開，留到上線後再補） */
  comment?: string
  commentDone?: boolean
}

export interface PostMeta {
  id: string
  title: string
  category: string
  postType: string
  sourceName: string
  sourceUrl: string
  platforms: string[]
  status: string
  missing: string[]
  links: PostLink[]
  note: string
  images: PostImage[]
  publishRecords: PublishRecord[]
  createdAt: string
  updatedAt: string
}

export interface Variant {
  id: string
  label: string
  platform: string
  locked: boolean
  /** 這個版本跟其他版本的差異，一句話；不會寫進文案 */
  note: string
  body: string
}

export interface Post extends PostMeta {
  variants: Variant[]
}

export function dataDir(): string {
  const cfg = useRuntimeConfig()
  const custom = (cfg.dataDir as string) || ''
  return custom ? resolve(custom) : resolve(process.cwd(), '..', 'data')
}

export function postsDir() {
  return join(dataDir(), 'posts')
}
export function inboxDir() {
  return join(dataDir(), 'inbox')
}

export function specPath(): string {
  const cfg = useRuntimeConfig()
  const custom = (cfg.specFile as string) || ''
  return custom ? resolve(custom) : resolve(process.cwd(), '..', '文案撰寫規範.md')
}

/**
 * 規範檔不存在就建一個空的。
 *
 * 版本庫裡不放任何範本 —— 撰寫規範是每個社群自己的東西，
 * 塞一份別人的進去只會讓產出像別人。使用者要自己丟。
 */
export async function ensureSpec(): Promise<string> {
  const p = specPath()
  if (!(await exists(p))) await fs.writeFile(p, '', 'utf8')
  return p
}

/** 規範是不是還沒填。空白或只有空行都算 */
export async function specIsEmpty(): Promise<boolean> {
  try {
    return !(await fs.readFile(specPath(), 'utf8')).trim()
  } catch {
    return true
  }
}

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

export async function exists(p: string) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(p: string, data: unknown) {
  await ensureDir(resolve(p, '..'))
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 只允許單純檔名／資料夾名，擋掉 ../ 之類的路徑穿越 */
export function safeSegment(name: string): string {
  const clean = basename(String(name || '')).replace(/[\\/:*?"<>|]/g, '')
  if (!clean || clean === '.' || clean === '..') throw createError({ statusCode: 400, message: '名稱不合法' })
  return clean
}

/**
 * 依「碼位」截斷字串。直接用 String.slice 會把 emoji 的 surrogate pair 切一半，
 * 產生非法 UTF-8——序列化成 JSON 或當成檔名都會爆。
 */
export function sliceChars(s: string, n: number): string {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('')
}

const SLUG_MAX = 48

export function slugify(input: string): string {
  const s = String(input || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[.]+$/, '')
  return sliceChars(s, SLUG_MAX) || 'post'
}

export function todayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export async function uniqueId(dir: string, base: string): Promise<string> {
  let id = base
  let i = 2
  while (await exists(join(dir, id))) {
    id = `${base}-${i}`
    i++
  }
  return id
}

export function emptyMeta(id: string, title: string): PostMeta {
  const now = new Date().toISOString()
  return {
    id,
    title,
    category: '情報',
    postType: '推坑・安利',
    sourceName: '',
    sourceUrl: '',
    platforms: ['facebook'],
    status: 'draft',
    missing: [],
    links: [],
    note: '',
    images: [],
    publishRecords: [],
    createdAt: now,
    updatedAt: now
  }
}

// ── variant 檔：frontmatter + 正文 ────────────────────────────────
export function serializeVariant(v: Variant): string {
  const fm = [
    '---',
    `id: ${v.id}`,
    `label: ${v.label}`,
    `platform: ${v.platform}`,
    `locked: ${v.locked ? 'true' : 'false'}`,
    `note: ${(v.note || '').replace(/[\r\n]+/g, ' ')}`,
    '---',
    ''
  ].join('\n')
  return fm + v.body.replace(/\r\n/g, '\n')
}

export function parseVariant(raw: string, fallbackId: string): Variant {
  const v: Variant = { id: fallbackId, label: '版本', platform: 'facebook', locked: false, note: '', body: '' }
  const text = raw.replace(/\r\n/g, '\n')
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 3)
    if (end !== -1) {
      const head = text.slice(4, end)
      v.body = text.slice(end + 5)
      for (const line of head.split('\n')) {
        const i = line.indexOf(':')
        if (i === -1) continue
        const k = line.slice(0, i).trim()
        const val = line.slice(i + 1).trim()
        if (k === 'id') v.id = val || fallbackId
        else if (k === 'label') v.label = val
        else if (k === 'platform') v.platform = val
        else if (k === 'locked') v.locked = val === 'true'
        else if (k === 'note') v.note = val
      }
      return v
    }
  }
  v.body = text
  return v
}

export async function loadPost(id: string): Promise<Post | null> {
  const dir = join(postsDir(), safeSegment(id))
  if (!(await exists(join(dir, 'post.json')))) return null
  const meta = await readJson<PostMeta>(join(dir, 'post.json'), emptyMeta(id, id))
  meta.id = id
  const variants: Variant[] = []
  const vdir = join(dir, 'variants')
  if (await exists(vdir)) {
    const files = (await fs.readdir(vdir)).filter(f => f.endsWith('.md')).sort()
    for (const f of files) {
      const raw = await fs.readFile(join(vdir, f), 'utf8')
      variants.push(parseVariant(raw, basename(f, '.md')))
    }
  }
  return { ...meta, variants }
}

export async function savePostMeta(meta: PostMeta) {
  meta.updatedAt = new Date().toISOString()
  const dir = join(postsDir(), safeSegment(meta.id))
  await ensureDir(dir)
  const { ...rest } = meta
  delete (rest as Record<string, unknown>).variants
  await writeJson(join(dir, 'post.json'), rest)
}

export async function listPosts(): Promise<Post[]> {
  const dir = postsDir()
  await ensureDir(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: Post[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = await loadPost(e.name)
    if (p) out.push(p)
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return out
}

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'])

export function extFromType(type: string, url = ''): string {
  const byUrl = extname(new URL(url, 'https://x.invalid').pathname).toLowerCase()
  if (IMAGE_EXT.has(byUrl)) return byUrl
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif'
  }
  return map[(type || '').split(';')[0]!.trim().toLowerCase()] || '.jpg'
}

export async function nextImageName(dir: string, ext: string): Promise<string> {
  await ensureDir(dir)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  let n = 1
  const used = new Set(files.map(f => basename(f, extname(f))))
  while (used.has(String(n).padStart(2, '0'))) n++
  return String(n).padStart(2, '0') + ext
}
