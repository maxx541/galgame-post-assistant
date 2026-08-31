// 平台設定：長度、hashtag 數量、截斷點，全部取自《文案撰寫規範.md》第四、五節

export interface PlatformSpec {
  key: string
  name: string
  short: string
  /** 建議正文長度（不含 hashtag 末行）[min, max]，null 表示不限 */
  body: [number | null, number | null]
  /** 平台硬上限 */
  hardMax: number | null
  /** hashtag 建議數量 [min, max] */
  tags: [number, number]
  /** 「顯示更多」截斷位置，會在編輯器與預覽卡畫線 */
  cutoff: number | null
  cutoffLabel: string
  /** 字數計法：cp = 碼位數（中文算 1）；weighted = X 加權（中日文算 2） */
  count: 'cp' | 'weighted'
  tip: string
}

export const PLATFORMS: PlatformSpec[] = [
  {
    key: 'facebook',
    name: 'Facebook',
    short: 'FB',
    body: [null, null],
    hardMax: null,
    tags: [1, 3],
    cutoff: 80,
    cutoffLabel: '「顯示更多」黃金區',
    count: 'cp',
    tip: '開頭一句抓住人，趕在「顯示更多」前；活動說明、回顧文可長，細節分段。'
  },
  {
    key: 'threads',
    name: 'Threads',
    short: 'TH',
    body: [100, 200],
    hardMax: 500,
    tags: [2, 4],
    cutoff: 200,
    cutoffLabel: '建議上限',
    count: 'cp',
    tip: '短、口語、可讀性高；開頭一句就點題。單則聚焦一個訊息點，情報／台詞盡量搭圖。'
  },
  {
    key: 'instagram',
    name: 'Instagram',
    short: 'IG',
    body: [138, 150],
    hardMax: 2200,
    tags: [3, 5],
    cutoff: 125,
    cutoffLabel: '首行摺疊點',
    count: 'cp',
    tip: 'caption 的關鍵字比 hashtag 更影響觸及，把作品名、角色、情報寫進句子裡。輪播最吃香。'
  },
  {
    key: 'x',
    name: 'X / Twitter',
    short: 'X',
    body: [71, 100],
    hardMax: 280,
    tags: [1, 3],
    cutoff: null,
    cutoffLabel: '',
    count: 'weighted',
    tip: '最精簡，一則一重點；面向日方時只留核心資訊。官方日文 tag 優先。'
  }
]

export const DEFAULT_PLATFORM = 'facebook'

export function getPlatform(key: string): PlatformSpec {
  return PLATFORMS.find(p => p.key === key) || PLATFORMS[0]!
}

/** 內容體裁標籤（第〇節第 1 條） */
export const CATEGORIES = ['情報', '心得', '分享', '成果', '社課', '企劃', '投票', '台詞', '音樂']

/** 文案子型（第二節決策樹） */
export const POST_TYPES = [
  { group: '社群活動宣傳', items: ['活動招募', '講座・讀書會預告', '里程碑・成果公告', '賽事・投票／展覽合作'] },
  { group: '作品推廣文案', items: ['推坑・安利', '發售・銷量／特賣公告'] }
]

/** 第三節：依類型必備欄位，缺項時前端列「待補」 */
export const REQUIRED_FIELDS: Record<string, string[]> = {
  '活動招募': ['活動名稱', '日期時間（含星期）', '地點', '報名連結', '名額', '費用', '報名截止'],
  '講座・讀書會預告': ['講題', '講者', '日期時間（含星期）', '地點', '共辦單位', '報名方式'],
  '里程碑・成果公告': ['里程碑數字', '致謝對象', '活動名稱'],
  '賽事・投票／展覽合作': ['活動名稱', '合作對象', '投票／參與連結', '期限', '攤位或規則'],
  '推坑・安利': ['作品全名', '開發商／品牌', '賣點（1–2 個記憶點）', '適合誰入坑'],
  '發售・銷量／特賣公告': ['作品全名', '折扣％或銷量數字', '原價／特價', '期限', '平台連結']
}

export const STATUSES = [
  { key: 'draft', label: '草稿', color: '#7c8794' },
  { key: 'needs-info', label: '待補資訊', color: '#c78a2a' },
  { key: 'ready', label: '已定稿', color: '#2f8f5b' },
  { key: 'published', label: '已發佈', color: '#4b6bdc' }
]

export function statusMeta(key: string) {
  return STATUSES.find(s => s.key === key) || STATUSES[0]!
}
