import { join } from 'node:path'

/**
 * 本機排程佇列。
 *
 * 為什麼不是全部交給 Meta：只有 Facebook 專頁的 API 支援排程
 * （published=false + scheduled_publish_time）。Instagram 有這個參數但鎖在
 * 白名單後面（實測回 `(#3) User must be on whitelist`），Threads 根本沒有。
 * 所以 IG 與 Threads 的排程只能由這裡在時間到時呼叫發佈。
 *
 * 代價很明確、也一定要讓使用者知道：**工具沒開著就不會發**。
 * Facebook 因此保留「交給 Meta 排程」的選項，那條路關機照發。
 */

export type SchedulePlatform = 'facebook' | 'instagram' | 'threads'

export interface ScheduledItem {
  id: string
  postId: string
  variantId: string
  platform: SchedulePlatform
  /** 預定發佈時間 */
  at: string
  status: 'pending' | 'done' | 'error' | 'cancelled'
  /** 導流連結，發完貼成第一則留言（Threads 不支援就略過） */
  comment: string
  externalId: string
  url: string
  error: string
  attempts: number
  createdAt: string
  doneAt: string
}

/** 到期後超過這麼久就不補發了 —— 隔天才開電腦，昨晚的貼文不該突然冒出來 */
export const STALE_MS = 6 * 60 * 60 * 1000
/** 失敗最多重試幾次 */
export const MAX_ATTEMPTS = 3

// ── 純函式 ────────────────────────────────────────────────────────

export function newScheduleItem(
  o: Partial<ScheduledItem> & { postId: string; variantId: string; platform: SchedulePlatform; at: string }
): ScheduledItem {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'pending',
    comment: '',
    externalId: '',
    url: '',
    error: '',
    attempts: 0,
    createdAt: new Date().toISOString(),
    doneAt: '',
    ...o
  }
}

/**
 * 現在該發哪幾則。
 * 過期太久的不發（回在 stale 裡讓呼叫端標成失敗），免得電腦隔天才開就一次全噴出去。
 */
export function dueItems(items: ScheduledItem[], now = Date.now()) {
  const due: ScheduledItem[] = []
  const stale: ScheduledItem[] = []
  for (const it of items) {
    if (it.status !== 'pending') continue
    const t = Date.parse(it.at)
    if (!Number.isFinite(t) || t > now) continue
    if (now - t > STALE_MS) stale.push(it)
    else due.push(it)
  }
  // 早的先發，同一則貼文的多平台才不會亂序
  due.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { due, stale }
}

/** 給畫面用的一句話 */
export function scheduleLabel(it: ScheduledItem): string {
  const name = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' }[it.platform]
  if (it.status === 'done') return `${name} 已發佈`
  if (it.status === 'error') return `${name} 失敗：${it.error}`
  if (it.status === 'cancelled') return `${name} 已取消`
  return `${name} 排定 ${it.at.slice(0, 16).replace('T', ' ')}`
}

/** 排程時間合不合理。本機排程沒有 Facebook 那個「至少 10 分鐘」的限制 */
export function validateLocalSchedule(at: string, now = Date.now()): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return '時間格式看不懂'
  if (t < now - 60_000) return '時間已經過了'
  if (t > now + 400 * 86400_000) return '排太遠了（超過一年）'
  return ''
}

// ── 讀寫 ──────────────────────────────────────────────────────────

export function schedulePath() {
  return join(dataDir(), 'schedule.json')
}

export async function loadSchedule(): Promise<ScheduledItem[]> {
  const d = await readJson<{ items?: ScheduledItem[] }>(schedulePath(), {})
  return Array.isArray(d.items) ? d.items : []
}

export async function saveSchedule(items: ScheduledItem[]) {
  // 完成的留一陣子就好，不然這個檔會一直長
  const keep = items
    .filter(x => x.status === 'pending')
    .concat(
      items
        .filter(x => x.status !== 'pending')
        .sort((a, b) => (b.doneAt || b.createdAt).localeCompare(a.doneAt || a.createdAt))
        .slice(0, 60)
    )
  await writeJson(schedulePath(), { items: keep })
  return keep
}

export async function addSchedule(o: Parameters<typeof newScheduleItem>[0]) {
  const items = await loadSchedule()
  const it = newScheduleItem(o)
  items.push(it)
  await saveSchedule(items)
  logInfo('schedule', `排程 ${it.platform} ${it.at}｜${it.postId}`)
  return it
}

export async function updateSchedule(id: string, patch: Partial<ScheduledItem>) {
  const items = await loadSchedule()
  const it = items.find(x => x.id === id)
  if (!it) return null
  Object.assign(it, patch)
  await saveSchedule(items)
  return it
}
