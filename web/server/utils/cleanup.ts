import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 定期清理：把放太久的貼文與素材資料夾整個刪掉（圖片也在裡面）。
 *
 * 列表頁每次都會把 posts/ 與 inbox/ 底下的資料夾全部讀一遍，東西越積越多就越慢，
 * 而且圖片是原尺寸存的，很快就吃掉幾百 MB。
 *
 * 預設關閉，而且兩邊預設都只刪「已經用完的」——貼文要發佈過、素材要撰寫過。
 * 還有排程在等的貼文無論如何都不刪。
 */

export interface CleanupSettings {
  enabled: boolean
  /** 幾天清一次，預設 7（每週） */
  intervalDays: number
  posts: { enabled: boolean; keepDays: number; onlyPublished: boolean }
  inbox: { enabled: boolean; keepDays: number; onlyWritten: boolean }
  lastRunAt: string
  lastResult: CleanupResult | null
}

export interface CleanupResult {
  at: string
  posts: number
  inbox: number
  bytes: number
  failed: number
}

export interface CleanupTarget {
  kind: 'posts' | 'inbox'
  id: string
  title: string
  /** 判斷新舊用的時間 */
  at: string
}

export function defaultCleanupSettings(): CleanupSettings {
  return {
    enabled: false,
    intervalDays: 7,
    posts: { enabled: true, keepDays: 30, onlyPublished: true },
    inbox: { enabled: true, keepDays: 14, onlyWritten: true },
    lastRunAt: '',
    lastResult: null
  }
}

function merge(raw: Partial<CleanupSettings> | undefined): CleanupSettings {
  const d = defaultCleanupSettings()
  const r = raw || {}
  return {
    ...d,
    ...r,
    posts: { ...d.posts, ...(r.posts || {}) },
    inbox: { ...d.inbox, ...(r.inbox || {}) }
  }
}

export async function loadCleanupSettings(): Promise<CleanupSettings> {
  const all = await readJson<{ cleanup?: Partial<CleanupSettings> }>(join(dataDir(), 'settings.json'), {})
  return merge(all.cleanup)
}

export async function saveCleanupSettings(patch: Partial<CleanupSettings>) {
  const p = join(dataDir(), 'settings.json')
  const all = await readJson<Record<string, unknown>>(p, {})
  const cur = merge(all.cleanup as Partial<CleanupSettings>)
  const next = merge({
    ...cur,
    ...patch,
    posts: { ...cur.posts, ...(patch.posts || {}) },
    inbox: { ...cur.inbox, ...(patch.inbox || {}) }
  })
  await writeJson(p, { ...all, cleanup: next })
  return next
}

/** 下次預定清理的時間；沒開或還沒跑過就回空字串 */
export function nextCleanupAt(s: CleanupSettings): string {
  if (!s.enabled) return ''
  const last = Date.parse(s.lastRunAt || '')
  if (!Number.isFinite(last)) return ''
  return new Date(last + Math.max(1, s.intervalDays) * 86400_000).toISOString()
}

export function cleanupIsDue(s: CleanupSettings, now = Date.now()) {
  if (!s.enabled) return false
  const last = Date.parse(s.lastRunAt || '')
  if (!Number.isFinite(last)) return true
  return now >= last + Math.max(1, s.intervalDays) * 86400_000
}

/** 發佈過了嗎：立即發過，或交給 Meta 排程且時間已經過了 */
function isPublished(p: PostMeta, now: number) {
  if (p.status === 'published') return true
  return (p.publishRecords || []).some(r => r.mode === 'schedule' && Date.parse(r.scheduledAt || '') < now)
}

/** 列出這次會刪哪些——預覽與實際清理共用同一份判斷 */
export async function findCleanupTargets(s: CleanupSettings, now = Date.now()): Promise<CleanupTarget[]> {
  const out: CleanupTarget[] = []

  if (s.posts.enabled) {
    const cutoff = now - Math.max(1, s.posts.keepDays) * 86400_000
    // 還有排程在等的貼文，刪了就發不出去
    const pending = new Set(
      (await loadSchedule().catch(() => [])).filter(it => it.status === 'pending').map(it => it.postId)
    )
    for (const p of await listPosts()) {
      if (pending.has(p.id)) continue
      if (s.posts.onlyPublished && !isPublished(p, now)) continue
      const at = p.updatedAt || p.createdAt
      const t = Date.parse(at || '')
      if (!Number.isFinite(t) || t > cutoff) continue
      out.push({ kind: 'posts', id: p.id, title: p.title, at })
    }
  }

  if (s.inbox.enabled) {
    const cutoff = now - Math.max(1, s.inbox.keepDays) * 86400_000
    for (const m of await listMaterials()) {
      if (s.inbox.onlyWritten && !m.written) continue
      const t = Date.parse(m.addedAt || '')
      if (!Number.isFinite(t) || t > cutoff) continue
      out.push({ kind: 'inbox', id: m.id, title: m.title || m.id, at: m.addedAt })
    }
  }

  return out
}

export async function runCleanup(reason: 'schedule' | 'manual'): Promise<CleanupResult> {
  const s = await loadCleanupSettings()
  const targets = await findCleanupTargets(s)
  const res: CleanupResult = { at: new Date().toISOString(), posts: 0, inbox: 0, bytes: 0, failed: 0 }

  for (const t of targets) {
    const dir = join(t.kind === 'posts' ? postsDir() : inboxDir(), safeSegment(t.id))
    try {
      if (!(await exists(dir))) continue
      res.bytes += await dirSize(dir)
      await fs.rm(dir, { recursive: true, force: true })
      res[t.kind]++
    } catch (e) {
      res.failed++
      logWarn('cleanup', `刪不掉 ${t.kind}/${t.id}：${(e as Error).message}`)
    }
  }

  await saveCleanupSettings({ lastRunAt: res.at, lastResult: res })
  const label = reason === 'schedule' ? '定期清理' : '手動清理'
  logOk(
    'cleanup',
    `${label}：刪除貼文 ${res.posts} 則、素材 ${res.inbox} 則，釋出 ${(res.bytes / 1048576).toFixed(1)}MB` +
      (res.failed ? `（${res.failed} 則失敗）` : '')
  )
  return res
}

/** 算資料夾佔多少空間 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else total += (await fs.stat(p).catch(() => ({ size: 0 }))).size
  }
  return total
}
