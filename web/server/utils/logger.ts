import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 後台活動記錄。
 * 一份印到終端機（開著的那個黑視窗）看即時狀況，一份存在記憶體給 /logs 頁看細節，
 * 再落一份 JSONL 到 data/logs/ 方便事後翻。
 * AI 呼叫會把完整的 request / response 存進 detail，方便你看它到底送了什麼。
 */

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface LogEntry {
  id: number
  at: string
  level: LogLevel
  /** 這筆是哪一類：ai / scrape / post / material / spec / system */
  kind: string
  msg: string
  /** 展開才看得到的細節；AI 呼叫會放完整 prompt 與回應 */
  detail?: Record<string, unknown>
  /** 毫秒 */
  ms?: number
}

const MAX_BUFFER = 400
const buffer: LogEntry[] = []
let seq = 1

const COLOR: Record<LogLevel, string> = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m'
}
const RESET = '\x1b[0m'
const DIM = '\x1b[90m'

function hhmmss(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 單一字串在記錄裡的長度上限，避免整份 log 被一段超長回應灌爆 */
const MAX_STRING = 20000

/**
 * 圖片是以 base64 data URL 送給模型的，那是正常的請求格式，
 * 但完整塞進記錄會讓畫面沒法看、log 檔暴漲，所以只留類型與大小。
 */
export function slimDataUrls(s: string): string {
  return s.replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{200,}/g, (m, mime) => {
    const kb = Math.round((m.length * 3) / 4 / 1024)
    return `data:${mime};base64,［圖片 ${kb.toLocaleString()} KB，記錄中省略］`
  })
}

/** 金鑰之類的東西不准進 log */
export function redact<T>(value: T): T {
  const seen = new WeakSet()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = slimDataUrls(v)
        .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…')
        .replace(/(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…')
        .replace(/(gg-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…')
        .replace(/(Bearer\s+\S{6})\S+/gi, '$1…')
      if (s.length <= MAX_STRING) return s
      return s.slice(0, MAX_STRING) + `…［後面還有 ${(s.length - MAX_STRING).toLocaleString()} 個字，已截斷］`
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return '[circular]'
      seen.add(v as object)
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/^(apikey|api_key|authorization|token|secret|password)$/i.test(k)) {
          out[k] = '［已隱藏］'
        } else {
          out[k] = walk(val)
        }
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

async function appendFile(e: LogEntry) {
  try {
    const dir = join(dataDir(), 'logs')
    await fs.mkdir(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    await fs.appendFile(join(dir, day + '.jsonl'), JSON.stringify(e) + '\n', 'utf8')
  } catch {
    /* 記錄失敗不能影響主流程 */
  }
}

export function log(level: LogLevel, kind: string, msg: string, detail?: Record<string, unknown>, ms?: number) {
  const e: LogEntry = {
    id: seq++,
    at: new Date().toISOString(),
    level,
    kind,
    msg,
    ms,
    detail: detail ? (redact(detail) as Record<string, unknown>) : undefined
  }
  buffer.push(e)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)

  const tail = ms !== undefined ? `${DIM} ${(ms / 1000).toFixed(1)}s${RESET}` : ''
  // eslint-disable-next-line no-console
  console.log(`${DIM}${hhmmss()}${RESET} ${COLOR[level]}${kind.padEnd(8)}${RESET} ${msg}${tail}`)

  void appendFile(e)
  return e
}

export const logInfo = (kind: string, msg: string, detail?: Record<string, unknown>, ms?: number) =>
  log('info', kind, msg, detail, ms)
export const logOk = (kind: string, msg: string, detail?: Record<string, unknown>, ms?: number) =>
  log('ok', kind, msg, detail, ms)
export const logWarn = (kind: string, msg: string, detail?: Record<string, unknown>, ms?: number) =>
  log('warn', kind, msg, detail, ms)
export const logErr = (kind: string, msg: string, detail?: Record<string, unknown>, ms?: number) =>
  log('error', kind, msg, detail, ms)

export function readLogs(sinceId = 0, limit = 200): LogEntry[] {
  const out = sinceId > 0 ? buffer.filter(e => e.id > sinceId) : buffer
  return out.slice(-limit)
}

export function clearLogs() {
  buffer.length = 0
}

export function lastId() {
  return seq - 1
}

/** 印一行分隔，讓終端機看得出一次操作的開始 */
export function logSection(title: string) {
  // eslint-disable-next-line no-console
  console.log(`${DIM}${'─'.repeat(20)} ${title} ${'─'.repeat(Math.max(0, 34 - [...title].length))}${RESET}`)
}
