// 規範檢查引擎 —— 將《文案撰寫規範.md》第〇節硬規定與第八節檢查清單程式化
import { getPlatform } from './platforms'

export type LintLevel = 'error' | 'warn' | 'info'

export interface LintIssue {
  id: string
  level: LintLevel
  rule: string // 規範出處
  message: string
  hint?: string
}

/** 表情符號偵測；安全清單屬「符號」而非 emoji，不視為違規 */
const EMOJI_SAFE = new Set(['♪', '♫', '♬', '™', '©', '®', '〜', '～'])
const EMOJI_RE = /(\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{FE0F}\u{20E3}])/gu

/** 第四節：少用過度行銷字眼 */
const SALES_WORDS = [
  '限時搶購', '錯過不再', '手刀下單', '快來買', '瘋搶', '賣爆', '破盤', '下殺',
  '震撼', '炸裂', '錯過後悔', '必買', '不買可惜', '最後機會', '刷爆'
]

const URL_RE = /https?:\/\/[^\s，。）)]+/g

/** 字數：cp = 碼位（中文算 1）；weighted = X 加權（中日韓與全形算 2） */
export function countChars(text: string, mode: 'cp' | 'weighted' = 'cp'): number {
  const chars = [...text]
  if (mode === 'cp') return chars.length
  let n = 0
  for (const ch of chars) {
    const c = ch.codePointAt(0) as number
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
    n += wide ? 2 : 1
  }
  return n
}

export interface SplitResult {
  lines: string[]
  nonEmpty: string[]
  firstLine: string
  lastLine: string
  /** 最末行若整行都是 hashtag，視為 tag 行 */
  tagLine: string | null
  tags: string[]
  /** 扣掉 tag 行後的正文 */
  body: string
}

export function splitPost(text: string): SplitResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nonEmpty = lines.filter(l => l.trim() !== '')
  const firstLine = nonEmpty[0] ?? ''
  const lastLine = nonEmpty[nonEmpty.length - 1] ?? ''
  const isTagLine =
    lastLine.trim() !== '' && lastLine.trim().split(/\s+/).every(t => t.startsWith('#'))
  const tagLine = isTagLine ? lastLine : null
  const tags = tagLine
    ? tagLine.trim().split(/\s+/).filter(Boolean)
    : (text.match(/(?:^|\s)(#[^\s#]+)/g) || []).map(s => s.trim())
  let body = text
  if (tagLine) {
    const idx = text.lastIndexOf(tagLine)
    body = text.slice(0, idx)
  }
  return { lines, nonEmpty, firstLine, lastLine, tagLine, tags, body: body.trim() }
}

export interface LintContext {
  platform: string
  /** 素材是否含導流連結（報名表單、商店頁等） */
  hasLinks?: boolean
  /** 已勾選圖片登記的繪師 */
  artists?: string[]
}

export function lintPost(text: string, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = []
  const p = getPlatform(ctx.platform)
  const s = splitPost(text)
  const add = (id: string, level: LintLevel, rule: string, message: string, hint?: string) =>
    issues.push({ id, level, rule, message, hint })

  if (!text.trim()) {
    add('empty', 'error', '—', '文案是空的')
    return issues
  }

  // 第〇節 1：首行必為【體裁】
  const m = s.firstLine.match(/^【([^】]*)】(.*)$/)
  if (!m) {
    add('category', 'error', '第〇節 ①', '首行沒有【體裁】標籤', '例如：【情報】ATRI 生日')
  } else {
    if (!(m[1] as string).trim()) add('category-empty', 'error', '第〇節 ①', '【】裡面是空的')
    if (!(m[2] as string).trim())
      add('category-title', 'warn', '第〇節 ①', '【體裁】後面缺標題', '如「【情報】CRYSTALA新品週邊登場」')
  }

  // 第〇節 3：禁止 emoji
  const found = [...new Set((text.match(EMOJI_RE) || []).filter(c => !EMOJI_SAFE.has(c)))]
  if (found.length) {
    add('emoji', 'error', '第〇節 ③', '出現 emoji：' + found.join(' '), '改用純文字、標點、換行或方括號分隔')
  }

  // 第〇節 2：來源標註
  const hasSource = /（來源[：:]|（主辦[：:]/.test(text)
  const hasHalfSource = /\(來源|\(主辦|來源:/.test(text)
  if (!hasSource && !hasHalfSource) {
    add('source', 'error', '第〇節 ②', '缺少（來源：XXX）', '填官方名稱或官方帳號 @handle；活動類可用（主辦：…）')
  } else {
    if (hasHalfSource && !/（來源：|（主辦：/.test(text)) {
      add('source-fullwidth', 'error', '第〇節 ②', '來源沒有用全形括號與全形冒號', '正確：（來源：ANIPLEX.EXE）')
    }
    const srcIdx = s.nonEmpty.findIndex(l => /（來源[：:]|（主辦[：:]|\(來源|\(主辦/.test(l))
    // hashtag 行 = 整行以 # 開頭；來源必須排在它之前
    const hashIdx = s.nonEmpty.findIndex(l => l.trim().startsWith('#'))
    if (srcIdx >= 0 && hashIdx >= 0 && srcIdx > hashIdx) {
      add('source-order', 'error', '第〇節 ②', '來源排在 hashtag 之後', '來源要放在內文結尾、hashtag 之前')
    }
    if (srcIdx === 0) {
      add('source-order2', 'warn', '第〇節 ②', '來源出現在首行，應放在內文結尾')
    }
  }

  // 第〇節 2：繪師標註
  if (/繪師/.test(text) && !/（繪師：/.test(text)) {
    add('artist-fullwidth', 'error', '第〇節 ②', '繪師標註沒有用全形括號與全形冒號', '正確：（繪師：@xxx @yyy）')
  }
  if (ctx.artists?.length && !/（繪師：/.test(text)) {
    add(
      'artist-missing',
      'warn',
      '第〇節 ②',
      '圖片已登記繪師（' + ctx.artists.join(' ') + '），但文案沒有標',
      '在來源行後另起一行加（繪師：…）'
    )
  }

  // 第〇節 4：網址一律放留言
  const urls = text.match(URL_RE) || []
  if (urls.length) {
    add('url-in-body', 'error', '第〇節 ④', '正文出現網址：' + urls[0], '正文改寫「網址放留言」，實際 URL 貼到留言區')
  }
  if (ctx.hasLinks && !/放留言/.test(text)) {
    add('url-note', 'warn', '第〇節 ④', '這則有導流連結，但正文沒寫「網址放留言」')
  }

  // 第五節：hashtag
  if (!s.tags.length) {
    add('tag-missing', 'warn', '第五節', '沒有任何 hashtag')
  } else {
    if (!s.tagLine) {
      add('tag-last', 'warn', '第五節', 'hashtag 沒有獨立放在最末行', 'tag 獨立一行放最後，方便複製')
    }
    const tmin = p.tags[0]
    const tmax = p.tags[1]
    if (s.tags.length < tmin || s.tags.length > tmax) {
      add('tag-count', 'warn', '第五節', p.name + ' 建議 ' + tmin + '–' + tmax + ' 個 tag，目前 ' + s.tags.length + ' 個')
    }
  }

  // 第四節：篇幅
  const bodyLen = countChars(s.body, p.count)
  const bmin = p.body[0]
  const bmax = p.body[1]
  const unit = p.count === 'weighted' ? '加權字元' : '字元'
  if (bmin !== null && bodyLen < bmin) {
    add('len-short', 'warn', '第四節', '正文 ' + bodyLen + ' ' + unit + '，' + p.name + ' 建議 ' + bmin + '–' + bmax)
  } else if (bmax !== null && bodyLen > bmax) {
    add('len-long', 'warn', '第四節', '正文 ' + bodyLen + ' ' + unit + '，' + p.name + ' 建議 ' + bmin + '–' + bmax)
  }
  if (p.hardMax && countChars(text, p.count) > p.hardMax) {
    add('len-hard', 'error', '第四節', '全文超過 ' + p.name + ' 上限 ' + p.hardMax + ' ' + unit)
  }

  // 第四節：過度行銷字眼
  const hits = SALES_WORDS.filter(w => text.includes(w))
  if (hits.length) {
    add('sales', 'warn', '第四節', '出現行銷式字眼：' + hits.join('、'), '這是同好情報分享，不是賣產品；改成分享語氣')
  }

  // 第四節：排版與重點前置
  if (countChars(s.body) > 120 && !/\n\s*\n/.test(s.body)) {
    add('spacing', 'info', '第四節', '長文沒有空行分段', '段落之間空行，手機閱讀友善')
  }
  if (p.cutoff) {
    const firstLen = countChars(s.firstLine, p.count)
    if (firstLen > p.cutoff) {
      add(
        'cutoff',
        'info',
        '第四節',
        '首行 ' + firstLen + ' ' + unit + '，已超過 ' + p.name + p.cutoffLabel + '（' + p.cutoff + '）',
        '重點前置，把最重要的一句放最前面'
      )
    }
  }

  return issues
}

export function lintSummary(issues: LintIssue[]) {
  const error = issues.filter(i => i.level === 'error').length
  const warn = issues.filter(i => i.level === 'warn').length
  const info = issues.filter(i => i.level === 'info').length
  return { error, warn, info, pass: error === 0 }
}
