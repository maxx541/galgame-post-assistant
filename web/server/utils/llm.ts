/**
 * 走 OpenAI 相容的 Chat Completions 介面，Base URL 與金鑰都可自訂。
 * 預設指向 Google Gemini 的 OpenAI 相容端點，換成別家（OpenRouter、本機 gateway…）只要改設定。
 * 沒有綁任何廠商 SDK，純 fetch。
 */
import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const DEFAULT_MODEL = 'gemini-2.5-pro'

/**
 * 圖片上限。base64 會把體積放大約 1/3，所以這裡的數字是「編碼前」的。
 * 光有單張上限不夠——發掘會從原文網頁抓 4 張全尺寸大圖，
 * 每張 2MB 都合法，加起來卻是 9.5MB 的請求，端點直接回 413。
 */
const MAX_IMAGE_BYTES = 2_500_000
const MAX_TOTAL_IMAGE_BYTES = 3_500_000
const MAX_IMAGES = 4
const REQUEST_TIMEOUT_MS = 180_000

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * 依碼位截斷，避免把 emoji 的 surrogate pair 切半（會產生非法 UTF-8）。
 * 這裡自帶一份而不用 store.ts 的 auto-import 版本，是為了讓這個模組能被測試直接 import。
 */
function cut(s: string, n: number): string {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('')
}

export const PLATFORM_KEYS = ['facebook', 'threads', 'instagram', 'x'] as const

/** 內容體裁（規範第〇節①）。與 app/utils/platforms.ts 的 CATEGORIES 一致 */
export const CATEGORY_KEYS = ['情報', '心得', '分享', '成果', '社課', '企劃', '投票', '台詞', '音樂'] as const

/** 文案子型（規範第二節決策樹）。與 app/utils/platforms.ts 的 POST_TYPES 一致 */
export const POST_TYPE_KEYS = [
  '活動招募',
  '講座・讀書會預告',
  '里程碑・成果公告',
  '賽事・投票／展覽合作',
  '推坑・安利',
  '發售・銷量／特賣公告'
] as const

/** 要模型回傳的結構（原生 JSON Schema，直接給 response_format 用） */
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: '這則貼文的標題，繁體中文、8 到 20 字，會用來當資料夾名稱與列表顯示'
    },
    category: {
      type: 'string',
      enum: [...CATEGORY_KEYS],
      description: '內容體裁（規範第〇節①），會成為文案首行的【】標籤'
    },
    postType: {
      type: 'string',
      enum: [...POST_TYPE_KEYS],
      description: '文案子型（規範第二節決策樹）。判斷不了時填「推坑・安利」'
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: '依規範第三節該子型的必備欄位中，這則素材沒有提供的；資訊齊全就回空陣列'
    },
    sourceName: {
      type: 'string',
      description: '建議填進（來源：…）的官方名稱或 @帳號；無法判斷就回空字串'
    },
    variants: {
      type: 'array',
      description: '依指定平台與版本數產出的所有版本',
      items: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description:
              '這個版本的名稱，3 到 8 個字，要看得出語氣差別。例如「熱血分享版」「溫和敘事版」「簡潔資訊版」「互動提問版」。不可留空，不同版本不可重複。'
          },
          platform: { type: 'string', enum: [...PLATFORM_KEYS], description: '這個版本針對的平台' },
          body: { type: 'string', description: '可直接複製貼上的貼文全文純文字，含首行【體裁】與最末行 hashtag' },
          note: { type: 'string', description: '這個版本跟其他版本的差異，一句話；不會寫進文案' }
        },
        required: ['label', 'platform', 'body', 'note'],
        additionalProperties: false
      }
    }
  },
  required: ['title', 'category', 'postType', 'missing', 'sourceName', 'variants'],
  additionalProperties: false
} as const

export interface DraftVariant {
  label: string
  platform: string
  body: string
  note: string
}
export interface Draft {
  title: string
  category: string
  postType: string
  missing: string[]
  sourceName: string
  variants: DraftVariant[]
}

export interface LlmSettings {
  baseUrl: string
  apiKey: string
  model: string
  /** 端點不支援看圖時關掉 */
  sendImages: boolean
  source: 'env' | 'file' | 'none'
}

export interface GenerateInput {
  spec: string
  /** 素材原始文字（推文內文、頁面摘要、你自己打的說明），是判斷與撰寫的主要依據 */
  text: string
  /** 使用者給的暫定標題，可空；模型會自己重下 */
  title: string
  platforms: string[]
  sourceName: string
  sourceUrl: string
  links: { label: string; url: string }[]
  artists: string[]
  extra: string
  /** 反饋優化累積下來的個人偏好，會接在規範後面注入 system prompt */
  memory: string
  perPlatform: number
  images: { media_type: string; data: string }[]
}

/**
 * 各平台的硬性數字。規範第四、五節有表格，但只靠表格模型會抓不準，
 * 所以在 prompt 裡對「這次要寫的平台」再講一次明確數字。
 * 數值必須與 app/utils/platforms.ts 一致——npm test 會比對兩邊。
 */
export const PLATFORM_RULES: Record<
  string,
  { label: string; body: [number | null, number | null]; tags: [number, number]; hint: string }
> = {
  facebook: { label: 'Facebook', body: [null, null], tags: [1, 3], hint: '前 80 字元最關鍵，開頭一句就要抓住人' },
  threads: { label: 'Threads', body: [100, 200], tags: [2, 4], hint: '短、口語，單則聚焦一個訊息點' },
  instagram: { label: 'Instagram', body: [138, 150], tags: [3, 5], hint: '首行即重點，作品名與角色寫進句子裡' },
  x: { label: 'X／Twitter', body: [71, 100], tags: [1, 3], hint: '最精簡，一則一重點' }
}

const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(PLATFORM_RULES).map(([k, v]) => [k, v.label])
)

function platformRuleLine(key: string): string {
  const r = PLATFORM_RULES[key]
  if (!r) return `・${key}`
  const [bmin, bmax] = r.body
  const len = bmin === null ? '正文長度不限' : `正文 ${bmin}–${bmax} 字`
  return `・${r.label}：${len}，hashtag ${r.tags[0]}–${r.tags[1]} 個，${r.hint}`
}

// ── 設定 ──────────────────────────────────────────────────────────
export async function loadSettings(): Promise<LlmSettings> {
  const cfg = useRuntimeConfig()
  const envBase = (cfg.llmBaseUrl as string) || process.env.LLM_BASE_URL || ''
  const envKey = (cfg.llmApiKey as string) || process.env.LLM_API_KEY || ''
  const envModel = (cfg.llmModel as string) || process.env.LLM_MODEL || ''

  const file = await readJson<Partial<LlmSettings>>(join(dataDir(), 'settings.json'), {})

  const apiKey = envKey.trim() || (file.apiKey || '').trim()
  const source: LlmSettings['source'] = envKey.trim() ? 'env' : apiKey ? 'file' : 'none'

  return {
    baseUrl: (envBase.trim() || file.baseUrl || DEFAULT_BASE_URL).trim(),
    apiKey,
    model: (envModel.trim() || file.model || DEFAULT_MODEL).trim(),
    sendImages: file.sendImages !== false,
    source
  }
}

/** 把使用者貼的各種形式的 Base URL 正規化成可用的端點 */
export function endpointFor(baseUrl: string, path: 'chat/completions' | 'models'): string {
  let b = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\s+/g, '')
  b = b.replace(/\/+$/, '')
  // 使用者直接貼了完整的 completions 網址
  b = b.replace(/\/chat\/completions$/i, '')
  b = b.replace(/\/models$/i, '')
  return `${b}/${path}`
}

// ── prompt ────────────────────────────────────────────────────────
export function buildSystemPrompt(spec: string, memory = ''): string {
  return `你是「GalGame文化同好會」社群粉專的文案撰寫者。以下是這個社群的完整《文案撰寫規範》，你產出的每一則文案都必須符合它。

<文案撰寫規範>
${spec}
</文案撰寫規範>

以下輸出規則優先於規範第六節「交付格式」——那一節描述的是人工交付，本次交付由系統處理：

1. 只輸出一個 JSON 物件，符合指定的 schema。不要輸出 JSON 以外的任何文字，不要用 \`\`\` 包起來。
2. variants[].body 必須是「可以直接複製貼上到平台」的純文字貼文全文，結構照規範的標準結構：
   第一行【體裁】標題 → 內文 → （來源：XXX）→（繪師：@…）若素材有插圖 → 最末行 hashtag。
3. body 裡**不得**出現：任何說明文字、markdown 標記（**、##、- 之類）、把文案包起來的引號、版本名稱、平台名稱。
4. body 裡**不得**出現任何網址。素材若有導流連結，正文改寫「網址放留言」（規範第〇節④）。
5. body 全文**不得**出現任何 emoji 或表情符號（規範第〇節③）。
6. **不要編造事實。** 素材沒給的日期、地點、名額、價格、折扣、發售日一律不要自己填。
   缺少的欄位放進 missing 陣列，並在 body 對應位置寫方括號佔位，例如「日期：［待補］」。
7. 每個版本的語氣要真的不同（熱血／溫和敘事／簡潔資訊…），不是換幾個詞而已；差異寫在 note。
8. 一律繁體中文。作品名用《》。角色名與作品名用通行譯名，不確定就沿用原文。
9. platform 只能填 facebook / threads / instagram / x 其中之一。
10. **先判斷再撰寫**：依規範第二節的決策樹，自己判斷這則素材的 category（體裁）與 postType（子型），
    並依第三節該子型的必備欄位，把素材沒提供的列進 missing。title 自己下一個 8–20 字的繁體中文標題。
11. **每個版本都必須有 label**：3 到 8 個字的版本名稱，一眼看得出語氣差別
    （例如「熱血分享版」「溫和敘事版」「簡潔資訊版」「互動提問版」）。不可留空，不同版本不可重複。
    note 則是一句話說明這個版本跟其他版本差在哪。label 和 note 都不會寫進文案。${memory || ''}`
}

export function buildUserText(input: GenerateInput): string {
  const lines: string[] = ['【素材】']
  if (input.title) lines.push(`暫定標題（僅供參考，你可以自己重下）：${input.title}`)
  if (input.sourceName) lines.push(`來源：${input.sourceName}`)
  if (input.sourceUrl) lines.push(`來源網址（僅供你理解素材，絕對不要寫進正文）：${input.sourceUrl}`)
  if (input.artists.length) lines.push(`插圖繪師：${input.artists.join(' ')}（要寫成（繪師：…）一行）`)
  if (input.links.length) {
    lines.push(
      `導流連結（正文寫「網址放留言」，不要寫出網址）：${input.links.map(l => l.label || '連結').join('、')}`
    )
  }
  if (input.images.length) lines.push(`附上 ${Math.min(input.images.length, MAX_IMAGES)} 張素材圖，請看圖判斷內容`)
  if (input.text.trim()) {
    lines.push('', '素材原文（原封不動，未經整理）：', '<素材原文>', input.text.trim(), '</素材原文>')
  }
  if (input.extra.trim()) lines.push('', '這次的額外指示：', input.extra.trim())

  const plats = input.platforms.length ? input.platforms : ['facebook']
  lines.push(
    '',
    '【要求】',
    `為以下每個平台各產出 ${input.perPlatform} 個語氣不同的版本：${plats
      .map(p => PLATFORM_LABEL[p] || p)
      .join('、')}`,
    '',
    '各平台的硬性限制（務必遵守，這比規範表格更明確）：',
    ...plats.map(platformRuleLine),
    '',
    'hashtag 數量超標是最常見的錯誤，送出前逐一數過。',
    '另外請一併判斷 title、category（體裁）、postType（子型）與 missing（缺哪些必備欄位）。',
    '產出前先在心裡跑一次規範第八節的檢查清單。'
  )
  return lines.join('\n')
}

export type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]

/** 純函式：組出 chat completions 的 request body，方便測試不用真的呼叫 */
export function buildChatRequest(
  input: GenerateInput,
  opts: { model: string; sendImages: boolean; jsonSchema: boolean }
) {
  const userContent: ChatContent = []
  if (opts.sendImages) {
    for (const img of input.images.slice(0, MAX_IMAGES)) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${img.media_type};base64,${img.data}` } })
    }
  }
  userContent.push({ type: 'text', text: buildUserText(input) })

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: buildSystemPrompt(input.spec, input.memory) },
      { role: 'user', content: userContent.length === 1 ? buildUserText(input) : userContent }
    ]
  }
  if (opts.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'post_drafts', strict: true, schema: DRAFT_SCHEMA }
    }
  } else {
    body.response_format = { type: 'json_object' }
  }
  return body
}

// ── 圖片 ──────────────────────────────────────────────────────────
const mb = (n: number) => (n / 1_000_000).toFixed(1) + 'MB'

/**
 * 在總量預算內挑要送給模型的圖。
 *
 * 第一張是主視覺（發掘那邊已經把最像主圖的排到最前面），優先保住；
 * 剩下的預算改成**小的先進**——同樣的位元組能讓模型多看到幾張，
 * 而且模型本來就會把圖縮到千把像素，送全尺寸原圖並不會看得更清楚。
 *
 * 純函式，不碰檔案系統，測得到。
 */
export function pickImagesWithinBudget(
  files: { name: string; size: number }[],
  limits = { count: MAX_IMAGES, perFile: MAX_IMAGE_BYTES, total: MAX_TOTAL_IMAGE_BYTES }
): { names: string[]; skipped: string[] } {
  const skipped: string[] = []
  const fit: { name: string; size: number }[] = []
  for (const f of files) {
    if (f.size > limits.perFile) skipped.push(`${f.name}（單張 ${mb(f.size)}，超過 ${mb(limits.perFile)}）`)
    else fit.push(f)
  }

  const chosen: string[] = []
  let used = 0
  const take = (f: { name: string; size: number }) => {
    chosen.push(f.name)
    used += f.size
  }

  const [first, ...others] = fit
  if (first) take(first)
  // 小的先進，同樣的預算能多看幾張
  for (const f of [...others].sort((a, b) => a.size - b.size)) {
    if (chosen.length >= limits.count || used + f.size > limits.total) continue
    take(f)
  }
  for (const f of fit) {
    if (!chosen.includes(f.name)) skipped.push(`${f.name}（總量已達 ${mb(limits.total)} 上限）`)
  }
  // 依原本的順序送出，主視覺才會是第一張
  return { names: fit.filter(f => chosen.includes(f.name)).map(f => f.name), skipped }
}

export async function loadImages(dir: string, files: string[]) {
  const out: { media_type: string; data: string }[] = []
  const skipped: string[] = []
  const sized: { name: string; size: number }[] = []

  for (const f of files) {
    if (!IMAGE_MIME[extname(f).toLowerCase()]) {
      skipped.push(`${f}（格式不支援）`)
      continue
    }
    try {
      sized.push({ name: f, size: (await fs.stat(join(dir, f))).size })
    } catch {
      skipped.push(`${f}（讀不到）`)
    }
  }

  const picked = pickImagesWithinBudget(sized)
  skipped.push(...picked.skipped)
  for (const f of picked.names) {
    try {
      const buf = await fs.readFile(join(dir, f))
      out.push({ media_type: IMAGE_MIME[extname(f).toLowerCase()]!, data: buf.toString('base64') })
    } catch {
      skipped.push(`${f}（讀不到）`)
    }
  }
  return { images: out, skipped }
}

// ── 回應解析 ──────────────────────────────────────────────────────
/** 模型有時會加 ``` 圍籬或前後贅字，盡量把 JSON 物件挖出來 */
export function extractJson(text: string): unknown {
  const t = (text || '').trim()
  if (!t) throw new Error('回應是空的')
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], t]
  for (const c of candidates) {
    if (!c) continue
    const s = c.trim()
    try {
      return JSON.parse(s)
    } catch {
      const first = s.indexOf('{')
      const last = s.lastIndexOf('}')
      if (first !== -1 && last > first) {
        try {
          return JSON.parse(s.slice(first, last + 1))
        } catch {
          /* 換下一個候選 */
        }
      }
    }
  }
  throw new Error('回應不是合法 JSON')
}

const FALLBACK_LABELS = ['熱血版', '敘事版', '簡潔版', '補充版']

/** 模型偶爾會漏填 label，補一個看得懂的：先從 note 取前半句，再退回固定名稱 */
function labelFor(raw: unknown, note: string, index: number): string {
  if (typeof raw === 'string' && raw.trim()) return cut(raw.trim(), 20)
  const head = note.split(/[，,。；;：:]/)[0]?.trim()
  if (head && [...head].length >= 2) return cut(head, 12)
  return FALLBACK_LABELS[index % FALLBACK_LABELS.length] as string
}

export function normalizeDraft(raw: unknown, fallbackPlatform: string, fallbackTitle = ''): Draft {
  const o = (raw || {}) as Record<string, unknown>
  const cats = new Set<string>(CATEGORY_KEYS)
  const types = new Set<string>(POST_TYPE_KEYS)
  const valid = new Set<string>(PLATFORM_KEYS)
  const variants = Array.isArray(o.variants) ? o.variants : []
  const out: DraftVariant[] = []
  for (const v of variants) {
    const x = (v || {}) as Record<string, unknown>
    const body = typeof x.body === 'string' ? x.body.trim() : ''
    if (!body) continue
    const p = typeof x.platform === 'string' ? x.platform.trim().toLowerCase() : ''
    const note = typeof x.note === 'string' ? x.note.trim() : ''
    out.push({
      label: labelFor(x.label, note, out.length),
      platform: valid.has(p) ? p : fallbackPlatform,
      body,
      note
    })
  }
  const title = typeof o.title === 'string' && o.title.trim() ? cut(o.title.trim(), 40) : fallbackTitle || '未命名貼文'
  const category = typeof o.category === 'string' && cats.has(o.category.trim()) ? o.category.trim() : '情報'
  const postType =
    typeof o.postType === 'string' && types.has(o.postType.trim()) ? o.postType.trim() : '推坑・安利'
  return {
    title,
    category,
    postType,
    missing: Array.isArray(o.missing) ? o.missing.filter(m => typeof m === 'string') : [],
    sourceName: typeof o.sourceName === 'string' ? o.sourceName.trim() : '',
    variants: out
  }
}

// ── 呼叫 ──────────────────────────────────────────────────────────
async function postChat(s: LlmSettings, body: unknown, tag = 'AI') {
  const url = endpointFor(s.baseUrl, 'chat/completions')
  const b = body as { model?: string; messages?: { role: string; content: unknown }[]; response_format?: { type?: string } }
  const msgChars = (b.messages || []).reduce((n, m) => {
    if (typeof m.content === 'string') return n + [...m.content].length
    if (Array.isArray(m.content)) {
      return n + m.content.reduce((k: number, c: { type?: string; text?: string }) =>
        k + (c.type === 'text' ? [...(c.text || '')].length : 0), 0)
    }
    return n
  }, 0)
  const imgCount = (b.messages || []).reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter((c: { type?: string }) => c.type === 'image_url').length : 0), 0)

  logInfo(
    'ai',
    `${tag} 送出 → ${b.model}｜prompt ${msgChars.toLocaleString()} 字${imgCount ? `＋${imgCount} 張圖` : ''}｜格式 ${b.response_format?.type || 'text'}`,
    { 端點: url, request: body }
  )

  const t0 = Date.now()
  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    text = await res.text()
  } catch (e) {
    logErr('ai', `${tag} 連線失敗：${(e as Error).message}`, { 端點: url }, Date.now() - t0)
    throw e
  }

  const ms = Date.now() - t0
  if (!res.ok) {
    logWarn('ai', `${tag} 回應 HTTP ${res.status}`, { 端點: url, response: cut(text, 4000) }, ms)
  } else {
    let usage = ''
    let content = ''
    try {
      const p = JSON.parse(text)
      const u = p.usage || {}
      usage = u.prompt_tokens ? `｜in ${u.prompt_tokens} / out ${u.completion_tokens ?? '?'} tokens` : ''
      content = p.choices?.[0]?.message?.content || ''
    } catch {
      /* 解析失敗下面照樣記原文 */
    }
    logOk('ai', `${tag} 回應 ${res.status}${usage}`, { 端點: url, 回應內容: content || cut(text, 4000), raw: cut(text, 8000) }, ms)
  }
  return { res, text }
}

function apiError(status: number, text: string): never {
  const short = cut(text, 400)
  if (status === 401 || status === 403) {
    throw createError({ statusCode: 401, message: 'API 金鑰被拒絕（HTTP ' + status + '）：' + short })
  }
  if (status === 404) {
    throw createError({ statusCode: 404, message: '端點或模型不存在（404）。檢查 Base URL 與模型名稱：' + short })
  }
  if (status === 429) {
    throw createError({ statusCode: 429, message: '被限流了（429），等一下再試：' + short })
  }
  if (status === 413) {
    throw createError({
      statusCode: 413,
      message:
        '請求太大（413），減圖之後端點還是不收。多半是內文太長，' +
        '把素材內文刪短一點，或到設定頁關掉「送圖給模型」：' + short
    })
  }
  throw createError({ statusCode: 502, message: `呼叫失敗（HTTP ${status}）：${short}` })
}

export async function listModels(s: LlmSettings): Promise<string[]> {
  const res = await fetch(endpointFor(s.baseUrl, 'models'), {
    headers: { authorization: `Bearer ${s.apiKey}` },
    signal: AbortSignal.timeout(30_000)
  })
  const text = await res.text()
  if (!res.ok) apiError(res.status, text)
  let data: { data?: { id?: string }[]; models?: { name?: string }[] }
  try {
    data = JSON.parse(text)
  } catch {
    throw createError({ statusCode: 502, message: '模型列表不是合法 JSON：' + text.slice(0, 200) })
  }
  const ids = (data.data || []).map(m => m.id).filter((x): x is string => !!x)
  if (ids.length) return ids.map(i => i.replace(/^models\//, '')).sort()
  return (data.models || []).map(m => (m.name || '').replace(/^models\//, '')).filter(Boolean).sort()
}

/**
 * 送一組 messages 過去、要一個 JSON 物件回來。
 * 給反饋優化這種單次任務用；主要的撰寫流程走 generateDrafts。
 */
export async function chatJson(
  messages: { role: 'system' | 'user'; content: string }[],
  schema: unknown,
  schemaName = 'result',
  maxTokens = 4000
): Promise<{ data: unknown; usage: Record<string, unknown>; model: string }> {
  const s = await loadSettings()
  if (!s.apiKey) {
    throw createError({ statusCode: 400, message: '還沒設定 API 金鑰。到「設定」頁填 Base URL、金鑰與模型名稱。' })
  }

  const base: Record<string, unknown> = { model: s.model, max_tokens: maxTokens, messages }
  let body = {
    ...base,
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
  }
  let { res, text } = await postChat(s, body, schemaName)
  if (!res.ok && /response_format|json_schema|schema|Unknown name|不支援/i.test(text)) {
    body = { ...base, response_format: { type: 'json_object' } } as typeof body
    ;({ res, text } = await postChat(s, body, schemaName + '(退回)'))
  }
  if (!res.ok) apiError(res.status, text)

  let payload: { choices?: { message?: { content?: string } }[]; usage?: Record<string, unknown>; model?: string }
  try {
    payload = JSON.parse(text)
  } catch {
    throw createError({ statusCode: 502, message: '回應不是合法 JSON：' + cut(text, 300) })
  }
  const content = payload.choices?.[0]?.message?.content || ''
  try {
    return { data: extractJson(content), usage: payload.usage || {}, model: payload.model || s.model }
  } catch (e) {
    throw createError({
      statusCode: 502,
      message: `回應無法解析（${(e as Error).message}）：` + cut(content, 300)
    })
  }
}

export async function generateDrafts(
  input: GenerateInput
): Promise<{ draft: Draft; usage: Record<string, unknown>; model: string; note: string }> {
  const fallbackTitle = input.title
  const s = await loadSettings()
  if (!s.apiKey) {
    throw createError({
      statusCode: 400,
      message: '還沒設定 API 金鑰。到「設定」頁填 Base URL、金鑰與模型名稱。'
    })
  }

  const fallbackPlatform = input.platforms[0] || 'facebook'
  let note = ''

  // 這幾個旗標會隨著退讓一路降級，重送時要沿用最新的狀態
  let cur = input
  let schema = true
  let withImages = s.sendImages

  // 先試 json_schema；端點不吃就退回 json_object
  let attempt = buildChatRequest(cur, { model: s.model, sendImages: withImages, jsonSchema: schema })
  let { res, text } = await postChat(s, attempt, '撰寫')

  if (!res.ok && /response_format|json_schema|schema|Unknown name|不支援/i.test(text)) {
    note = '端點不支援 json_schema，已退回 json_object 模式'
    logWarn('ai', '端點不吃 json_schema，退回 json_object 重送')
    schema = false
    attempt = buildChatRequest(cur, { model: s.model, sendImages: withImages, jsonSchema: schema })
    ;({ res, text } = await postChat(s, attempt, '撰寫(退回)'))
  }

  // 請求大小的上限各家端點不一樣，光靠自己算預算擋不住所有情況。
  // 收到 413 就把圖砍半重送，砍到沒圖為止——寧可少看幾張，也不要整篇寫不出來。
  while (!res.ok && res.status === 413 && withImages && cur.images.length > 0) {
    const half = Math.floor(cur.images.length / 2)
    note = half
      ? `請求太大（413），已減到 ${half} 張圖重送`
      : '請求太大（413），已改成純文字重送'
    logWarn('ai', `413 請求過大，圖片 ${cur.images.length} → ${half} 張重送`)
    cur = { ...cur, images: cur.images.slice(0, half) }
    if (!half) withImages = false
    attempt = buildChatRequest(cur, { model: s.model, sendImages: withImages, jsonSchema: schema })
    ;({ res, text } = await postChat(s, attempt, `撰寫(減圖${half})`))
  }

  if (!res.ok && withImages && cur.images.length && /image|vision|multimodal|content|part/i.test(text)) {
    note = '端點看起來不支援圖片，已改成純文字重送（可到設定頁關掉送圖）'
    logWarn('ai', '端點不吃圖片，改成純文字重送')
    withImages = false
    schema = false
    attempt = buildChatRequest(cur, { model: s.model, sendImages: withImages, jsonSchema: schema })
    ;({ res, text } = await postChat(s, attempt, '撰寫(純文字)'))
  }
  if (!res.ok) apiError(res.status, text)

  let payload: {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    usage?: Record<string, unknown>
    model?: string
  }
  try {
    payload = JSON.parse(text)
  } catch {
    throw createError({ statusCode: 502, message: '回應不是合法 JSON：' + text.slice(0, 300) })
  }

  const choice = payload.choices?.[0]
  if (!choice) throw createError({ statusCode: 502, message: '回應沒有 choices：' + text.slice(0, 300) })
  if (choice.finish_reason === 'length') {
    throw createError({ statusCode: 502, message: '輸出被長度截斷，減少版本數再試一次' })
  }
  const content = choice.message?.content || ''

  let draft: Draft
  try {
    draft = normalizeDraft(extractJson(content), fallbackPlatform, fallbackTitle)
  } catch (e) {
    throw createError({
      statusCode: 502,
      message: `模型回應無法解析成預期格式（${(e as Error).message}）：` + cut(content, 300)
    })
  }
  if (!draft.variants.length) {
    throw createError({ statusCode: 502, message: '模型沒有產出任何版本，再試一次或換個模型' })
  }
  return { draft, usage: payload.usage || {}, model: payload.model || s.model, note }
}
