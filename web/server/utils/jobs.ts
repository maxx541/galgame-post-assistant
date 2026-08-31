import { join } from 'node:path'

/**
 * 背景工作。
 *
 * 為什麼要這個：抓素材、AI 撰寫、發掘抓取以前都是「前端發一個很長的請求，
 * 等它回來」。使用者一切換視窗，瀏覽器就把分頁降級 —— setTimeout 被節流到
 * 一分鐘一次、分頁甚至可能被系統回收，工作就這樣斷在半路。
 *
 * 改成：請求只負責「開一個工作」馬上回 id，真正的事情在伺服器上跑完。
 * 前端輪詢進度就好，切視窗、換頁、關分頁都不影響，重新打開還能接回來。
 *
 * 狀態順便寫進 data/jobs.json，dev server 熱重載（這個專案很常發生）
 * 之後前端還讀得到最後的結果，不會只剩一句「工作不見了」。
 */

export interface JobLogLine {
  at: string
  ok: boolean
  text: string
}

export interface Job {
  id: string
  /** collect 抓素材 / write 撰寫 / discover 發掘 */
  kind: string
  label: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** 總步數；開始時不一定知道，可以中途 setTotal */
  total: number
  done: number
  /** 現在在做什麼，給進度條下面那行字用 */
  message: string
  log: JobLogLine[]
  error: string
  startedAt: string
  finishedAt: string
  /** 這個工作支不支援中途停止 */
  canStop: boolean
  /** 使用者按了停止，但工作還沒真的收尾。畫面要一直顯示「停止中」 */
  stopRequested: boolean
  result: unknown
}

/** 記憶體裡最多留幾個工作 */
const MAX_JOBS = 30
const MAX_LOG = 200

// ── 純函式（測得到，不依賴 auto-import）────────────────────────────

export function newJob(kind: string, label: string, total = 0, canStop = false): Job {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label,
    status: 'running',
    total,
    done: 0,
    message: '準備中…',
    log: [],
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    canStop,
    stopRequested: false,
    result: null
  }
}

/** 進度百分比。總數還不知道時回 -1，讓畫面改用不定長度的動畫 */
export function jobPercent(j: Pick<Job, 'total' | 'done' | 'status'>): number {
  if (j.status !== 'running') return 100
  if (!j.total || j.total < 0) return -1
  return Math.max(0, Math.min(100, Math.round((j.done / j.total) * 100)))
}

/** 還要多久。跑不到兩步的時候不猜，寧可不顯示 */
export function jobEta(
  j: Pick<Job, 'total' | 'done' | 'startedAt' | 'status'>,
  now = Date.now()
): number {
  if (j.status !== 'running' || !j.total || j.done < 2) return 0
  const elapsed = now - Date.parse(j.startedAt)
  if (!(elapsed > 0)) return 0
  const per = elapsed / j.done
  return Math.max(0, Math.round((j.total - j.done) * per))
}

export function jobSummary(j: Job): string {
  if (j.status === 'error') return '失敗：' + j.error
  if (j.status === 'stopped') return `已停止，完成 ${j.done}${j.total ? ` / ${j.total}` : ''}`
  if (j.status === 'done') return `完成 ${j.done}${j.total ? ` / ${j.total}` : ''}`
  return j.message
}

/** 舊的先丟，執行中的一律留著 */
export function trimJobs(jobs: Job[], max = MAX_JOBS): Job[] {
  const running = jobs.filter(j => j.status === 'running')
  const rest = jobs
    .filter(j => j.status !== 'running')
    .sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt))
  return [...running, ...rest].slice(0, max)
}

// ── 執行（用 auto-import）──────────────────────────────────────────

const jobs = new Map<string, Job>()
const stopFlags = new Set<string>()
/** 每個工作一個，按停止時 abort，讓跑在外部行程裡的工作也停得下來 */
const aborters = new Map<string, AbortController>()

export function jobsPath() {
  return join(dataDir(), 'jobs.json')
}

let saveTimer: NodeJS.Timeout | null = null
/**
 * 寫檔用防抖。一則工作可能一秒更新好幾次，每次都寫檔太傷，
 * 但也不能不寫 —— 熱重載之後前端要接得回來。
 */
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeJson(jobsPath(), { items: trimJobs([...jobs.values()]) }).catch(() => {})
  }, 400)
}

/** 熱重載後把上次的工作讀回來，執行中的標成停止（那個 process 已經沒了） */
async function hydrate() {
  if (jobs.size) return
  const d = await readJson<{ items?: Job[] }>(jobsPath(), {})
  for (const j of d.items || []) {
    if (j.status === 'running') {
      j.status = 'stopped'
      j.error = '伺服器重新啟動，這個工作沒有跑完'
      j.finishedAt = new Date().toISOString()
    }
    jobs.set(j.id, j)
  }
}

export interface JobCtx {
  id: string
  /** 完成一步。text 會進 log，也會變成進度條下面那行字 */
  step(text: string, ok?: boolean): void
  /** 只記一行字，不算一步 */
  note(text: string, ok?: boolean): void
  setTotal(n: number): void
  /** 使用者按了停止就回 true，長迴圈每圈檢查一次 */
  shouldStop(): boolean
  /**
   * 按停止時會 abort 的訊號。
   *
   * 光靠 shouldStop() 不夠 —— 抓一個 X 帳號要一分鐘，那段時間迴圈根本回不到
   * 檢查點，畫面上就是「按了沒反應」。把這個訊號傳給 execFile，按停止會直接
   * 把那個 Chromium 行程砍掉，馬上就停得下來。
   */
  signal: AbortSignal
  /** 會在等待途中檢查停止旗標的 sleep */
  sleep(ms: number): Promise<void>
}

/**
 * 開一個背景工作，馬上回 Job（不等它跑完）。
 * fn 丟出來的例外會被接住寫進 job.error，不會變成未處理的 rejection。
 */
export function startJob(
  kind: string,
  label: string,
  fn: (ctx: JobCtx) => Promise<unknown>,
  opts: { total?: number; canStop?: boolean } = {}
): Job {
  const job = newJob(kind, label, opts.total || 0, opts.canStop !== false)
  jobs.set(job.id, job)
  const aborter = new AbortController()
  aborters.set(job.id, aborter)

  const push = (text: string, ok: boolean) => {
    job.log.push({ at: new Date().toISOString(), ok, text })
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG)
    job.message = text
    scheduleSave()
  }

  const ctx: JobCtx = {
    id: job.id,
    step(text, ok = true) {
      job.done++
      push(text, ok)
    },
    note(text, ok = true) {
      push(text, ok)
    },
    setTotal(n) {
      job.total = Math.max(0, n)
      scheduleSave()
    },
    shouldStop() {
      return stopFlags.has(job.id)
    },
    signal: aborter.signal,
    async sleep(ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (stopFlags.has(job.id)) return
        await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())))
      }
    }
  }

  void (async () => {
    try {
      job.result = await fn(ctx)
      job.status = stopFlags.has(job.id) ? 'stopped' : 'done'
      job.message = jobSummary(job)
    } catch (e) {
      job.status = 'error'
      job.error = (e as { message?: string }).message || String(e)
      job.message = '失敗：' + job.error
      logWarn('job', `${label} 失敗：${job.error}`)
    } finally {
      job.finishedAt = new Date().toISOString()
      stopFlags.delete(job.id)
      aborters.delete(job.id)
      for (const [id, j] of [...jobs.entries()]) {
        if (!trimJobs([...jobs.values()]).some(x => x.id === id)) jobs.delete(id)
        void j
      }
      scheduleSave()
      logOk('job', `${label} ${job.status === 'done' ? '完成' : job.status}｜${job.done}/${job.total || '?'}`)
    }
  })()

  logInfo('job', `開始 ${label}`)
  return job
}

export async function getJob(id: string): Promise<Job | undefined> {
  await hydrate()
  return jobs.get(id)
}

export async function listJobs(kind?: string): Promise<Job[]> {
  await hydrate()
  const all = trimJobs([...jobs.values()])
  return kind ? all.filter(j => j.kind === kind) : all
}

/** 找這個類型還在跑的那個。前端重新整理之後靠這個接回進度條 */
export async function activeJob(kind: string): Promise<Job | undefined> {
  return (await listJobs(kind)).find(j => j.status === 'running')
}

export function stopJob(id: string) {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return false
  stopFlags.add(id)
  j.stopRequested = true
  j.message = '停止中…'
  // 砍掉正在跑的外部行程（抓 X 的 Chromium），不然要等它自己跑完
  aborters.get(id)?.abort()
  scheduleSave()
  return true
}
