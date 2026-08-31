import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * Facebook 專頁發佈（Graph API）。
 * 只做「自己管理自己的專頁」這個情境，App 留在開發模式即可，不用送 App Review。
 *
 * 流程：短期 User Token → 換長期 User Token → 取 Page Token（不會過期）→ 發文。
 * 多圖是先把每張圖以 published=false 上傳到 /photos 拿 media id，
 * 再用 /feed 帶 attached_media 組成一則多圖貼文，這樣三種發佈模式才能共用同一條路。
 */

/** Graph API 版本。Meta 每隔一段時間會淘汰舊版，設定頁可以改 */
export const DEFAULT_GRAPH_VERSION = 'v21.0'
const GRAPH = 'https://graph.facebook.com'
/** 一則貼文最多帶幾張圖 */
export const MAX_PHOTOS = 10
/** 排程下限 10 分鐘、上限約 6 個月 */
export const SCHEDULE_MIN_MS = 10 * 60 * 1000
export const SCHEDULE_MAX_MS = 180 * 24 * 60 * 60 * 1000

/**
 * now      立即發佈
 * draft    未發佈貼文（published=false）。**這不是 Business Suite 的草稿** ——
 *          它不會出現在動態、已發佈、已排程任何一個清單裡，只剩管理員連結進得去。
 * schedule 排程（published=false + scheduled_publish_time）。這個才會出現在
 *          Business Suite 的「已排程」，可以在那裡改時間或提前發。
 */
export type PublishMode = 'now' | 'draft' | 'schedule'

export interface MetaSettings {
  appId: string
  appSecret: string
  pageId: string
  pageName: string
  pageToken: string
  graphVersion: string
  /** 換 Page Token 用的 token；發文本身用不到 */
  userToken: string
  /** system = 企業平台的系統用戶 token（永久）；user = 一般 User Token（換過長期，約 60 天） */
  tokenKind: string
  tokenCheckedAt: string

  /** IG 商業帳號 id。留空可以用專頁自動偵測 */
  igUserId: string
  igUsername: string
  /**
   * Threads 走自己的 OAuth（graph.threads.net），**不吃 Page Token**，
   * 所以要另外存一組。
   */
  threadsUserId: string
  threadsToken: string
  threadsUsername: string
}

export function emptyMetaSettings(): MetaSettings {
  return {
    appId: '',
    appSecret: '',
    pageId: '',
    pageName: '',
    pageToken: '',
    graphVersion: DEFAULT_GRAPH_VERSION,
    igUserId: '',
    igUsername: '',
    threadsUserId: '',
    threadsToken: '',
    threadsUsername: '',
    userToken: '',
    tokenKind: '',
    tokenCheckedAt: ''
  }
}

export async function loadMeta(): Promise<MetaSettings> {
  const all = await readJson<{ meta?: Partial<MetaSettings> }>(join(dataDir(), 'settings.json'), {})
  return { ...emptyMetaSettings(), ...(all.meta || {}) }
}

export async function saveMeta(m: Partial<MetaSettings>) {
  const p = join(dataDir(), 'settings.json')
  const all = await readJson<Record<string, unknown>>(p, {})
  const cur = { ...emptyMetaSettings(), ...((all.meta as Partial<MetaSettings>) || {}) }
  await writeJson(p, { ...all, meta: { ...cur, ...m } })
  return await loadMeta()
}

export function graphUrl(version: string, path: string, params: Record<string, string> = {}) {
  const v = (version || DEFAULT_GRAPH_VERSION).replace(/^\/?/, '')
  const u = new URL(`${GRAPH}/${v}/${path.replace(/^\//, '')}`)
  for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val)
  return u.toString()
}

/** Graph API 的錯誤訊息藏在 error.message，挖出來給人看。純函式，方便測試 */
export function parseGraphError(text: string): string {
  let msg = cut(text, 400)
  try {
    const e = JSON.parse(text)?.error
    if (e) {
      msg = [e.message, e.error_user_title, e.error_user_msg].filter(Boolean).join('｜')
      if (e.code) msg += `（code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}）`
    }
  } catch {
    /* 不是 JSON 就用原文 */
  }
  return msg
}

export function graphError(status: number, text: string): never {
  throw createError({
    statusCode: status === 401 || status === 403 ? 401 : 502,
    message: 'Facebook：' + parseGraphError(text)
  })
}

export async function graphGet(version: string, path: string, params: Record<string, string>) {
  const url = graphUrl(version, path, params)
  const t0 = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  const text = await res.text()
  logInfo('meta', `GET ${path}`, { url: url.replace(/access_token=[^&]+/, 'access_token=［已隱藏］'), response: cut(text, 3000) }, Date.now() - t0)
  if (!res.ok) graphError(res.status, text)
  return JSON.parse(text)
}

export async function graphPost(version: string, path: string, form: FormData, label = path) {
  const url = graphUrl(version, path)
  const t0 = Date.now()
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
  const text = await res.text()
  const shown: Record<string, unknown> = {}
  for (const [k, v] of form.entries()) {
    shown[k] = k === 'access_token' ? '［已隱藏］' : v instanceof File ? `［檔案 ${v.name} ${Math.round(v.size / 1024)} KB］` : String(v)
  }
  const ms = Date.now() - t0
  if (!res.ok) {
    logWarn('meta', `POST ${label} 失敗 HTTP ${res.status}`, { url, request: shown, response: cut(text, 3000) }, ms)
    graphError(res.status, text)
  }
  logOk('meta', `POST ${label} 成功`, { url, request: shown, response: cut(text, 2000) }, ms)
  return JSON.parse(text)
}

function cut(s: string, n: number) {
  const a = [...String(s ?? '')]
  return a.length <= n ? a.join('') : a.slice(0, n).join('') + '…'
}

// ── 連接流程 ──────────────────────────────────────────────────────
/** 短期 User Token → 長期（約 60 天） */
export async function exchangeLongLivedToken(appId: string, appSecret: string, shortToken: string, version: string) {
  const d = await graphGet(version, 'oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken
  })
  if (!d.access_token) throw createError({ statusCode: 502, message: '沒有換到長期 token' })
  return d.access_token as string
}

export interface PageInfo {
  id: string
  name: string
  access_token: string
  category?: string
}

/** 列出這個帳號管理的專頁；用長期 User Token 取到的 Page Token 不會過期 */
export async function listPages(userToken: string, version: string): Promise<PageInfo[]> {
  const d = await graphGet(version, 'me/accounts', {
    access_token: userToken,
    fields: 'id,name,access_token,category',
    limit: '100'
  })
  return Array.isArray(d.data) ? d.data : []
}

export async function inspectToken(token: string, appId: string, appSecret: string, version: string) {
  const d = await graphGet(version, 'debug_token', {
    input_token: token,
    access_token: `${appId}|${appSecret}`
  })
  const x = d.data || {}
  return {
    valid: !!x.is_valid,
    type: String(x.type || ''),
    scopes: Array.isArray(x.scopes) ? (x.scopes as string[]) : [],
    expiresAt: x.expires_at ? new Date(x.expires_at * 1000).toISOString() : '',
    neverExpires: x.expires_at === 0
  }
}

/** 發文與留言需要的權限。少了 pages_manage_engagement 就沒辦法自動貼留言 */
export const REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement'
]

/**
 * 判斷這個 token 還需不需要換成長期。
 * 企業平台的系統用戶 token 本來就不會過期，硬拿去 fb_exchange_token 反而會出錯。
 */
export function needsExchange(info: { neverExpires: boolean; expiresAt: string }) {
  if (info.neverExpires) return false
  if (!info.expiresAt) return false
  // 還有超過 7 天的，當作已經是長期的
  return new Date(info.expiresAt).getTime() - Date.now() < 7 * 24 * 3600_000
}

export function describeToken(info: { neverExpires: boolean; expiresAt: string; type: string }) {
  if (info.neverExpires) return '永久有效（系統用戶 token）'
  if (!info.expiresAt) return '沒有回報到期時間'
  return '到期 ' + new Date(info.expiresAt).toLocaleString('zh-TW')
}

export function missingScopes(scopes: string[]) {
  return REQUIRED_SCOPES.filter(s => !scopes.includes(s))
}

/**
 * IG 讀不到時，多半不是「沒連 IG」而是「token 是加權限之前產的」。
 * 這兩件事的處理方式完全不同，所以訊息要分得開。
 */
export function igDiagnosis(scopes: string[]): string {
  const lack = IG_SCOPES.filter(x => !scopes.includes(x))
  if (!lack.length) {
    return (
      '這個專頁上找不到 Instagram 商業帳號。token 權限是齊的，' +
      '所以要確認 IG 已經轉成商業／創作者帳號，而且在專頁設定裡連到了這個專頁。'
    )
  }
  return (
    `這組 Page Token 少了 ${lack.join('、')} 權限` +
    (scopes.length ? `（目前有：${scopes.join('、')}）` : '') +
    '。在 App 那邊按過授權還不夠 —— **舊 token 不會自動長出新權限**，' +
    '要拿新的 User Token 重新產一次 Page Token 才會帶上。'
  )
}

// ── 發佈 ──────────────────────────────────────────────────────────
export interface PublishInput {
  message: string
  /** 本機圖片完整路徑，會逐張上傳 */
  imagePaths: string[]
  mode: PublishMode
  /** mode = schedule 時的發佈時間（毫秒） */
  scheduledAt?: number
  /** 要貼到第一則留言的文字，沒有就不貼 */
  comment?: string
}

export function validateSchedule(mode: PublishMode, scheduledAt?: number, now = Date.now()) {
  if (mode !== 'schedule') return ''
  if (!scheduledAt) return '排程要給發佈時間'
  const diff = scheduledAt - now
  if (diff < SCHEDULE_MIN_MS) return 'Facebook 規定排程至少要在 10 分鐘之後'
  if (diff > SCHEDULE_MAX_MS) return 'Facebook 規定排程最多約 6 個月內'
  return ''
}

/** 組出 /feed 的參數。抽出來是為了不呼叫 Meta 也能驗證組裝正確 */
export function buildFeedParams(
  message: string,
  mediaIds: string[],
  mode: PublishMode,
  scheduledAt?: number
): Record<string, string> {
  const params: Record<string, string> = { message }
  mediaIds.slice(0, MAX_PHOTOS).forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })
  })
  if (mode === 'now') {
    params.published = 'true'
  } else {
    // 草稿與排程都是先不發佈；排程再多給一個時間
    params.published = 'false'
    if (mode === 'schedule' && scheduledAt) {
      params.scheduled_publish_time = String(Math.floor(scheduledAt / 1000))
    }
  }
  return params
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * 直接指定粉專時用：拿 token 去要這個粉專的 Page Access Token。
 * 系統用戶如果沒有把粉專掛在 /me/accounts 底下，就走這條。
 */
export async function fetchPageToken(pageId: string, token: string, version: string) {
  const d = await graphGet(version, pageId, {
    access_token: token,
    fields: 'id,name,access_token,category'
  })
  if (!d.access_token) {
    throw createError({
      statusCode: 400,
      message: '這個 token 拿不到該粉專的 Page Token。確認系統用戶已被指派這個粉專，且權限是「管理粉絲專頁」。'
    })
  }
  return d as PageInfo
}

/** 上傳單張圖但先不發佈，回傳 media id */
export async function uploadPhoto(m: MetaSettings, filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  const name = basename(filePath)
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const form = new FormData()
  form.append('access_token', m.pageToken)
  form.append('published', 'false')
  form.append('source', new File([new Uint8Array(buf)], name, { type: IMAGE_MIME[ext] || 'image/jpeg' }))
  const d = await graphPost(m.graphVersion, `${m.pageId}/photos`, form, `${m.pageId}/photos（${name}）`)
  if (!d.id) throw createError({ statusCode: 502, message: '圖片上傳沒有回傳 id' })
  return String(d.id)
}

export function postPermalink(postId: string) {
  // {pageId}_{postId} 形式的 id 直接接在網域後面就能開
  return `https://www.facebook.com/${postId}`
}

export async function publishToPage(m: MetaSettings, input: PublishInput) {
  if (!m.pageId || !m.pageToken) {
    throw createError({ statusCode: 400, message: '還沒連接 Facebook 專頁。到「設定」頁完成連接。' })
  }
  const bad = validateSchedule(input.mode, input.scheduledAt)
  if (bad) throw createError({ statusCode: 400, message: bad })

  const modeLabel = input.mode === 'now' ? '立即發佈' : input.mode === 'draft' ? '存成未發佈貼文' : '排程發佈'
  logInfo('meta', `${modeLabel}到「${m.pageName || m.pageId}」｜${input.imagePaths.length} 張圖`)

  const mediaIds: string[] = []
  for (const p of input.imagePaths.slice(0, MAX_PHOTOS)) {
    mediaIds.push(await uploadPhoto(m, p))
  }

  const params = buildFeedParams(input.message, mediaIds, input.mode, input.scheduledAt)
  const form = new FormData()
  form.append('access_token', m.pageToken)
  for (const [k, v] of Object.entries(params)) form.append(k, v)
  const d = await graphPost(m.graphVersion, `${m.pageId}/feed`, form, `${m.pageId}/feed`)
  const postId = String(d.id || '')
  if (!postId) throw createError({ statusCode: 502, message: '發佈沒有回傳貼文 id' })

  // 未發佈與排程的貼文還沒公開，留言會失敗，留到真的上線後再貼
  let commentId = ''
  let commentSkipped = ''
  if (input.comment?.trim()) {
    if (input.mode === 'now') {
      commentId = await addComment(m, postId, input.comment.trim())
    } else {
      commentSkipped =
        input.mode === 'schedule'
          ? '貼文還沒上線，留言等排程時間到了再按「補貼留言」'
          : '貼文還沒公開，先按「發佈這則」把它轉成公開，再按「補貼留言」'
    }
  }

  logOk('meta', `${modeLabel}完成｜貼文 ${postId}${commentId ? '｜留言已貼' : ''}`)
  return { postId, permalink: postPermalink(postId), commentId, commentSkipped, photos: mediaIds.length }
}

/**
 * 把一則未發佈（published=false 建出來的暗貼）改成公開。
 *
 * 為什麼需要這個：`/{page}/feed` 帶 `published=false` 不會產生 Business Suite 的
 * 「草稿」，而是產生**未發佈貼文**——它有 id、有管理員看得到的連結，但
 * 不在 feed、不在已發佈、也不在已排程，等於在後台裡找不到。實測過：
 * `is_published=false`，四個 edge 全部查不到它。
 * 所以留一條路把它轉正，否則那則貼文就卡在那裡。
 */
export async function publishUnpublished(m: MetaSettings, postId: string) {
  if (!m.pageToken) {
    throw createError({ statusCode: 400, message: '還沒連接 Facebook 專頁。到「設定」頁完成連接。' })
  }
  const form = new FormData()
  form.append('access_token', m.pageToken)
  form.append('is_published', 'true')
  await graphPost(m.graphVersion, postId, form, `${postId}（轉成公開）`)
  logOk('meta', `未發佈貼文已轉成公開｜${postId}`)
  return { postId, permalink: postPermalink(postId) }
}

/** 查一則貼文現在到底是什麼狀態，用來確認「到底發出去了沒」 */
export async function postState(m: MetaSettings, postId: string) {
  const d = await graphGet(m.graphVersion, postId, {
    access_token: m.pageToken,
    fields: 'id,is_published,created_time,permalink_url,scheduled_publish_time'
  })
  return {
    id: String(d.id || postId),
    isPublished: d.is_published === true,
    createdTime: String(d.created_time || ''),
    permalink: String(d.permalink_url || postPermalink(postId)),
    scheduledPublishTime: d.scheduled_publish_time ? Number(d.scheduled_publish_time) : 0
  }
}

/** 表單欄位都是字串時的簡寫，省得每次自己組 FormData */
export async function graphPostParams(
  m: MetaSettings,
  path: string,
  params: Record<string, string>
) {
  const form = new FormData()
  form.append('access_token', m.pageToken)
  for (const [k, v] of Object.entries(params)) form.append(k, v)
  return await graphPost(m.graphVersion, path, form, path)
}

/** 刪一個 Graph 物件。發佈完要用它清掉借網址用的暫存照片 */
export async function graphDelete(version: string, path: string, token: string) {
  const url = graphUrl(version, path, { access_token: token })
  const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(60_000) })
  const text = await res.text()
  if (!res.ok) graphError(res.status, text)
  return JSON.parse(text)
}

/**
 * 判斷這個 App 發出去的貼文別人到底看不看得到。
 *
 * 背景：開發模式的 App 發到粉專的貼文只有 App 的角色成員看得到，別人開起來是
 * 「目前無法查看此內容」。而且**從 API 完全看不出異常** —— is_published 是 true、
 * privacy 是 EVERYONE、也沒有 is_hidden，本人也看得到。
 *
 * Graph API 沒有任何欄位直接回報 App 模式，所以只能用證據推。第一版拿
 * 「隱私政策與分類有沒有填」來猜，結果是錯的：那兩欄早就填好了，而且一次查
 * 多個欄位時 Graph 會把讀不到的欄位**靜靜略過**，看起來就像是空的。
 *
 * 改用真正露餡的訊號：**互動數**。這個 App 發的貼文如果清一色 0 互動，
 * 而同一個粉專其他貼文都有正常互動，那就是別人看不到。實測就是這個樣子——
 * 工具發的兩則 0 讚，手動發的每則 16–66 讚。
 */
export interface AppModeCheck {
  appId: string
  appName: string
  /** 切上線的必填項，只是照實回報，不拿來當判斷依據 */
  hasPrivacyPolicy: boolean
  hasCategory: boolean
  /** 用 App 發的貼文數 / 其中零互動的則數 */
  appPosts: number
  appPostsWithZero: number
  /** 其他（多半是手動發的）貼文的互動中位數 */
  otherMedian: number
  /** 看起來別人看不到 */
  likelyHidden: boolean
  hint: string
}

/** 取中位數，避免單一爆紅貼文把平均拉歪 */
function median(xs: number[]): number {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m]! : Math.round((a[m - 1]! + a[m]!) / 2)
}

export async function checkAppMode(
  m: MetaSettings,
  appPostIds: string[] = []
): Promise<AppModeCheck> {
  const out: AppModeCheck = {
    appId: m.appId,
    appName: '',
    hasPrivacyPolicy: false,
    hasCategory: false,
    appPosts: 0,
    appPostsWithZero: 0,
    otherMedian: 0,
    likelyHidden: false,
    hint: ''
  }
  if (!m.appId || !m.appSecret || !m.pageToken) {
    out.hint = '還沒連接完成，沒辦法檢查。'
    return out
  }

  // 這兩個欄位一次查一個 —— 一起查的話 Graph 會把讀不到的靜靜丟掉，看起來像沒填
  const token = `${m.appId}|${m.appSecret}`
  for (const [field, key] of [
    ['privacy_policy_url', 'hasPrivacyPolicy'],
    ['category', 'hasCategory']
  ] as const) {
    try {
      const d = await graphGet(m.graphVersion, m.appId, { access_token: token, fields: field })
      const v = String((d as Record<string, unknown>)[field] || '').trim()
      out[key] = !!v
      if (!out.appName && d.name) out.appName = String(d.name)
    } catch {
      /* 讀不到就當沒填 */
    }
  }

  if (!appPostIds.length) {
    out.hint = '還沒用這個工具發過貼文，沒有東西可以比對。'
    return out
  }

  try {
    const feed = await graphGet(m.graphVersion, `${m.pageId}/feed`, {
      access_token: m.pageToken,
      fields: 'id,reactions.summary(true),comments.summary(true)',
      limit: '25'
    })
    const rows = (feed.data || []) as Record<string, unknown>[]
    const mine: number[] = []
    const others: number[] = []
    for (const x of rows) {
      const id = String(x.id || '')
      const r = ((x.reactions as { summary?: { total_count?: number } })?.summary?.total_count || 0) +
        ((x.comments as { summary?: { total_count?: number } })?.summary?.total_count || 0)
      if (appPostIds.includes(id)) mine.push(r)
      else others.push(r)
    }
    out.appPosts = mine.length
    out.appPostsWithZero = mine.filter(x => x === 0).length
    out.otherMedian = median(others)

    // 全部零互動、而且別人發的明顯有互動 —— 這就是「只有你看得到」的樣子
    out.likelyHidden =
      mine.length > 0 && out.appPostsWithZero === mine.length && out.otherMedian >= 5
  } catch (e) {
    out.hint = '讀不到粉專貼文，沒辦法比對：' + ((e as Error).message || '')
    return out
  }

  if (out.likelyHidden) {
    out.hint =
      `工具發的 ${out.appPosts} 則互動全是 0，其他貼文中位數 ${out.otherMedian}。` +
      'App 多半還在開發模式，那種狀態下發到 Facebook 的貼文只有你自己看得到（IG 不受影響）。'
  } else if (out.appPosts) {
    out.hint = `工具發的 ${out.appPosts} 則互動正常。`
  } else {
    out.hint = '工具發的貼文不在最近 25 則裡，沒得比對。'
  }
  return out
}

// ── Instagram ─────────────────────────────────────────────────────
/** IG 發佈要的權限，跟發 FB 那組是分開的 */
export const IG_SCOPES = ['instagram_basic', 'instagram_content_publish']

/** 從專頁問出綁在上面的 IG 商業帳號。省得使用者自己去翻 id */
export async function detectInstagram(m: MetaSettings) {
  if (!m.pageId || !m.pageToken) {
    throw createError({ statusCode: 400, message: '要先連接 Facebook 專頁' })
  }
  const d = await graphGet(m.graphVersion, m.pageId, {
    access_token: m.pageToken,
    fields: 'instagram_business_account{id,username}'
  })
  const ig = (d.instagram_business_account || {}) as { id?: string; username?: string }
  if (!ig.id) {
    // 直接問 token 到底有哪些權限，才不會讓使用者在「沒連 IG」和「token 太舊」之間亂猜
    let scopes: string[] = []
    try {
      if (m.appId && m.appSecret) {
        scopes = (await inspectToken(m.pageToken, m.appId, m.appSecret, m.graphVersion)).scopes
      }
    } catch {
      /* 查不到權限就退回一般訊息 */
    }
    throw createError({ statusCode: 404, message: igDiagnosis(scopes) })
  }
  return { igUserId: String(ig.id), igUsername: String(ig.username || '') }
}

/** 確認 IG 帳號讀得到，順便把使用者名稱抓回來顯示 */
export async function testInstagram(m: MetaSettings) {
  const id = m.igUserId.trim()
  if (!id) throw createError({ statusCode: 400, message: '還沒填 Instagram 帳號 ID' })
  const d = await graphGet(m.graphVersion, id, {
    access_token: m.pageToken,
    fields: 'id,username,followers_count,media_count'
  })
  return {
    id: String(d.id || id),
    username: String(d.username || ''),
    followers: Number(d.followers_count || 0),
    mediaCount: Number(d.media_count || 0)
  }
}

// ── Threads ───────────────────────────────────────────────────────
/** Threads 是另一個網域，不是 graph.facebook.com */
export const THREADS_GRAPH = 'https://graph.threads.net'

export async function threadsGet(path: string, params: Record<string, string>) {
  const u = new URL(`${THREADS_GRAPH}/v1.0/${path.replace(/^\//, '')}`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const res = await fetch(u.toString())
  const text = await res.text()
  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(text)
  } catch {
    throw createError({ statusCode: 502, message: 'Threads 回應不是 JSON：' + text.slice(0, 200) })
  }
  if (!res.ok) {
    const err = (d.error || {}) as { message?: string }
    throw createError({
      statusCode: res.status,
      message: `Threads API 錯誤（HTTP ${res.status}）：${err.message || text.slice(0, 200)}`
    })
  }
  return d
}

/** 確認 Threads 的 token 與 user id 對得上 */
export async function testThreads(m: MetaSettings) {
  const tok = m.threadsToken.trim()
  if (!tok) throw createError({ statusCode: 400, message: '還沒填 Threads Access Token' })
  const who = m.threadsUserId.trim() || 'me'
  const d = await threadsGet(who, {
    access_token: tok,
    fields: 'id,username,threads_profile_picture_url'
  })
  return { id: String(d.id || ''), username: String(d.username || '') }
}

export async function addComment(m: MetaSettings, postId: string, message: string) {
  const form = new FormData()
  form.append('access_token', m.pageToken)
  form.append('message', message)
  const d = await graphPost(m.graphVersion, `${postId}/comments`, form, `${postId}/comments`)
  return String(d.id || '')
}
