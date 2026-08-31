import { join } from 'node:path'

/**
 * 反饋優化的記憶庫。
 * 使用者改完 AI 產的稿子後，比對原稿與終稿，提煉出「跨貼文都適用」的個人風格偏好，
 * 累積成規則庫；之後每次撰寫都把規則與最近的修訂範例注入 system prompt。
 * 存成 JSON 檔，跟其他資料一樣可以直接開來看、手動改。
 */

export const RULE_CATEGORIES = ['排版', '語調', '用詞', '符號與標點', '結構', '長度', '其他'] as const

export interface StyleRule {
  id: string
  rule: string
  category: string
  /** 觀察到幾次。同一條偏好重複出現就加權，注入時優先帶高權重的 */
  weight: number
  createdAt: string
  updatedAt: string
}

export interface HistoryEntry {
  postId: string
  variantId: string
  platform: string
  aiDraft: string
  userFinal: string
  at: string
}

const MAX_RULES = 60
const MAX_HISTORY = 40
/** 注入 prompt 時最多帶幾條規則、幾組範例 */
const INJECT_RULES = 14
const INJECT_EXAMPLES = 2

export function memoryDir() {
  return join(dataDir(), 'memory')
}
export function rulesPath() {
  return join(memoryDir(), 'rules.json')
}
export function historyPath() {
  return join(memoryDir(), 'history.json')
}

export async function loadRules(): Promise<StyleRule[]> {
  const d = await readJson<{ rules?: StyleRule[] }>(rulesPath(), {})
  return Array.isArray(d.rules) ? d.rules : []
}
export async function saveRules(rules: StyleRule[]) {
  await writeJson(rulesPath(), { rules: rules.slice(0, MAX_RULES) })
}
export async function loadHistory(): Promise<HistoryEntry[]> {
  const d = await readJson<{ items?: HistoryEntry[] }>(historyPath(), {})
  return Array.isArray(d.items) ? d.items : []
}
export async function saveHistory(items: HistoryEntry[]) {
  await writeJson(historyPath(), { items: items.slice(0, MAX_HISTORY) })
}

/** 比對用的正規化：忽略空白與標點差異，避免同一條規則被記成兩條 */
export function ruleKey(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？,.;:!?「」『』（）()【】\[\]"'`~]/g, '')
}

export function mergeRules(existing: StyleRule[], incoming: { rule: string; category: string }[]) {
  const now = new Date().toISOString()
  const out = existing.map(r => ({ ...r }))
  const index = new Map(out.map((r, i) => [ruleKey(r.rule), i]))
  const added: StyleRule[] = []
  const bumped: StyleRule[] = []

  for (const inc of incoming) {
    const text = String(inc.rule || '').trim()
    if (!text) continue
    const key = ruleKey(text)
    const at = index.get(key)
    if (at !== undefined) {
      const r = out[at] as StyleRule
      r.weight += 1
      r.updatedAt = now
      bumped.push(r)
    } else {
      const r: StyleRule = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        rule: text,
        category: (RULE_CATEGORIES as readonly string[]).includes(inc.category) ? inc.category : '其他',
        weight: 1,
        createdAt: now,
        updatedAt: now
      }
      out.push(r)
      index.set(key, out.length - 1)
      added.push(r)
    }
  }

  // 權重高的排前面，同權重看誰比較新
  out.sort((a, b) => b.weight - a.weight || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return { rules: out, added, bumped }
}

/** 組出要塞進 system prompt 的記憶段落；沒有記憶時回空字串 */
export function buildMemoryBlock(rules: StyleRule[], history: HistoryEntry[]): string {
  const top = rules.slice(0, INJECT_RULES)
  const ex = history.slice(0, INJECT_EXAMPLES)
  if (!top.length && !ex.length) return ''

  const parts: string[] = []
  if (top.length) {
    parts.push(
      '',
      '<個人偏好>',
      '以下是從這位使用者過去實際修改你的稿子中歸納出來的偏好。',
      '這些偏好的優先度低於上面的《文案撰寫規範》，但高於你自己的習慣——兩者衝突時以規範為準。',
      ...top.map(r => `・[${r.category}] ${r.rule}（觀察到 ${r.weight} 次）`),
      '</個人偏好>'
    )
  }
  if (ex.length) {
    parts.push('', '<修訂範例>', '使用者實際怎麼改你的稿子（左為你的原稿，右為他的終稿）：')
    ex.forEach((h, i) => {
      parts.push(
        `── 範例 ${i + 1}（${h.platform}）──`,
        '［AI 原稿］',
        cutText(h.aiDraft, 700),
        '［使用者終稿］',
        cutText(h.userFinal, 700)
      )
    })
    parts.push('</修訂範例>')
  }
  return parts.join('\n')
}

function cutText(s: string, n: number) {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('') + '…'
}

/** 反思用的輸出格式 */
export const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      description: '從這次修改中歸納出的個人風格偏好，最多 3 條；差異太小就回空陣列',
      items: {
        type: 'object',
        properties: {
          rule: {
            type: 'string',
            description: '具體、可執行的規則，20 到 45 字。不可包含這則貼文的具體內容（作品名、日期、活動名）'
          },
          category: { type: 'string', enum: [...RULE_CATEGORIES], description: '這條規則屬於哪一類' },
          evidence: { type: 'string', description: '在這次修改中，哪個地方看出這個偏好，一句話' }
        },
        required: ['rule', 'category', 'evidence'],
        additionalProperties: false
      }
    },
    summary: { type: 'string', description: '這次修改整體上改了什麼，一句話' }
  },
  required: ['rules', 'summary'],
  additionalProperties: false
} as const

export function buildReflectMessages(
  aiDraft: string,
  userFinal: string,
  platform: string,
  existing: StyleRule[]
) {
  const known = existing.slice(0, 30).map(r => `・${r.rule}`).join('\n')
  const system = `你在觀察一位社群小編怎麼修改 AI 產出的貼文，目的是歸納出他的個人寫作偏好，讓之後的 AI 稿子更接近他要的樣子。

規則怎麼寫：
1. 要**具體、可執行**。好的例子：「日期一律寫成 10/9（五）這種格式，不要寫成 10月9日星期五」「開頭第一句直接講重點，不要加問候語」「條列用「・」不要用「-」」。
   壞的例子：「文案要更吸引人」「語氣要好一點」——這種不要寫。
2. 只歸納**跨貼文都適用**的風格偏好。這一則的具體內容（作品名、角色名、日期、活動名、商品名）**絕對不要**寫進規則。
3. 只看使用者「主動改動」的部分。單純補上素材沒給的資訊、修錯字、換行位置微調，不算風格偏好。
4. 兩份稿子差異很小、或看不出穩定偏好時，rules 回**空陣列**。寧可少記也不要記錯。
5. 最多 3 條。
6. **絕對不要**歸納出跟下面這幾條硬規定衝突的規則——那些是社群的鐵則，使用者不會想改掉它們，
   看起來像是要改掉它們的差異，多半是使用者手滑或這一則的特例：
   ・第一行必須是【體裁】加標題
   ・內文結尾、hashtag 之前必須有（來源：XXX）
   ・全文不得出現任何 emoji
   ・導流網址不放正文，要寫「網址放留言」

輸出格式（rules 的每一項都是物件，不是字串）：
{
  "summary": "這次修改整體上改了什麼，一句話",
  "rules": [
    { "rule": "日期一律寫成 10/9（五），不要寫成 10月9日星期五", "category": "用詞", "evidence": "把「10月9日星期五」改成「10/9（五）」" }
  ]
}
沒有可歸納的偏好時：{ "summary": "…", "rules": [] }

${known ? `已經記錄過的規則如下。如果這次觀察到的偏好和其中一條是**同一件事**，rule 請「一字不差」照抄那一條（系統會自動加權），不要換句話說：\n${known}` : '目前還沒有記錄過任何規則。'}

只輸出一個 JSON 物件，符合指定的 schema，不要輸出其他文字。`

  const user = `這則貼文是要發到 ${platform}。

［AI 原稿］
${aiDraft}

［使用者終稿］
${userFinal}`

  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user }
  ]
}

/** 規則若跟規範硬規定衝突就丟掉——記憶庫的優先度低於規範，不該記反向的東西 */
const CONFLICT_PATTERNS: RegExp[] = [
  /不要?(寫|放|加|附).{0,6}(網址放留言|來源)/,
  /(可以|要|請|改).{0,4}(用|加|放).{0,4}emoji/i,
  /(不要?|取消|拿掉|移除).{0,8}(【[^】]*】|體裁標籤|來源標註)/,
  /網址.{0,6}(直接|可以).{0,4}(放|寫).{0,4}正文/
]

export function isConflictingRule(rule: string): boolean {
  const t = String(rule || '')
  return CONFLICT_PATTERNS.some(re => re.test(t))
}

export function normalizeReflection(raw: unknown) {
  const o = (raw || {}) as Record<string, unknown>
  const list = Array.isArray(o.rules) ? o.rules : []
  const rules: { rule: string; category: string; evidence: string }[] = []
  const dropped: string[] = []

  for (const r of list.slice(0, 5)) {
    // 模型有時會回字串陣列而不是物件陣列，兩種都接
    let rule = ''
    let category = '其他'
    let evidence = ''
    if (typeof r === 'string') {
      rule = r.trim()
    } else if (r && typeof r === 'object') {
      const x = r as Record<string, unknown>
      rule = typeof x.rule === 'string' ? x.rule.trim() : typeof x.text === 'string' ? x.text.trim() : ''
      if (typeof x.category === 'string') category = x.category.trim()
      if (typeof x.evidence === 'string') evidence = x.evidence.trim()
    }
    if (!rule) continue
    if (isConflictingRule(rule)) {
      dropped.push(rule)
      continue
    }
    if (!(RULE_CATEGORIES as readonly string[]).includes(category)) category = '其他'
    rules.push({ rule: cutText(rule, 80), category, evidence })
    if (rules.length >= 3) break
  }

  return { rules, dropped, summary: typeof o.summary === 'string' ? o.summary.trim() : '' }
}
