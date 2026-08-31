import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * 發佈到 Instagram 與 Threads。
 *
 * 兩邊都**只吃公開網址的圖片，不能直接上傳檔案**（官方文件：we cURL your
 * image using the URL provided so it must be on a public server）。本機工具
 * 沒有公開網址，所以走這條：
 *
 *   本機圖 → 以 published=false 傳到 FB 專頁 → 讀 ?fields=images 拿 CDN 網址
 *          → 餵給 IG／Threads 的容器 → 發佈 → 把暫存的 FB 照片刪掉
 *
 * 實測可行（CDN 網址不帶 token 也抓得到），而且不必辦第三方圖床。
 * 缺點是那是 Meta 的簽章網址，哪天改規則就得換成真的圖床。
 *
 * 另外兩邊都沒有排程 API：FB 的 scheduled_publish_time 在 IG 會回
 * 「(#3) User must be on whitelist」，Threads 則是整個參數被忽略。
 * 所以這兩個平台的排程一律由本機的排程器在時間到時呼叫這裡。
 */

/** IG 一則最多 10 張（輪播），Threads 一樣 */
const MAX_MEDIA = 10
/** 等容器處理完的上限 */
const CONTAINER_TIMEOUT_MS = 90_000

export interface PublishResult {
  externalId: string
  permalink: string
  photos: number
  commentId: string
  commentSkipped: string
  notes: string[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 把本機圖片變成公開網址。回傳網址與暫存的 FB photo id
 * （發佈完要拿去刪，不然專頁會累積一堆看不見的未發佈照片）。
 */
export async function toPublicUrls(m: MetaSettings, imagePaths: string[]) {
  const urls: string[] = []
  const tempPhotoIds: string[] = []
  const notes: string[] = []

  for (const p of imagePaths.slice(0, MAX_MEDIA)) {
    const buf = await fs.readFile(p)
    const form = new FormData()
    form.append('access_token', m.pageToken)
    form.append('published', 'false')
    form.append('source', new Blob([new Uint8Array(buf)]), basename(p))
    const d = await graphPost(m.graphVersion, `${m.pageId}/photos`, form, `暫存圖片 ${basename(p)}`)
    const id = String(d.id || '')
    if (!id) throw createError({ statusCode: 502, message: '上傳暫存圖片沒有回傳 id' })
    tempPhotoIds.push(id)

    const info = await graphGet(m.graphVersion, id, { access_token: m.pageToken, fields: 'images' })
    const imgs = (info.images || []) as { source: string; width: number; height: number }[]
    if (!imgs.length) throw createError({ statusCode: 502, message: '拿不到暫存圖片的公開網址' })
    const best = [...imgs].sort((a, b) => (b.width || 0) - (a.width || 0))[0]!
    urls.push(best.source)
    if (extname(p).toLowerCase() !== '.jpg' && extname(p).toLowerCase() !== '.jpeg') {
      notes.push(`${basename(p)} 不是 JPEG，已透過 Facebook 轉檔（IG 只吃 JPEG）`)
    }
  }
  return { urls, tempPhotoIds, notes }
}

/** 把暫存的 FB 照片刪掉。失敗不影響已經發出去的貼文，記一筆就好 */
export async function cleanupTempPhotos(m: MetaSettings, ids: string[]) {
  for (const id of ids) {
    try {
      await graphDelete(m.graphVersion, id, m.pageToken)
    } catch (e) {
      logWarn('meta', `暫存圖片 ${id} 沒刪成功：${(e as Error).message}`)
    }
  }
}

/** 等容器處理完。IG 會給 status_code，Threads 沒有就直接等固定秒數 */
async function waitContainer(m: MetaSettings, containerId: string, label: string) {
  const end = Date.now() + CONTAINER_TIMEOUT_MS
  while (Date.now() < end) {
    const d = await graphGet(m.graphVersion, containerId, {
      access_token: m.pageToken,
      fields: 'status_code,status'
    })
    const code = String(d.status_code || '')
    if (code === 'FINISHED') return
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw createError({
        statusCode: 502,
        message: `${label} 處理失敗（${code}）：${String(d.status || '').slice(0, 200)}`
      })
    }
    await sleep(2500)
  }
  throw createError({ statusCode: 504, message: `${label} 等太久還沒處理完` })
}

// ── Instagram ─────────────────────────────────────────────────────

export async function publishToInstagram(
  m: MetaSettings,
  input: { message: string; imagePaths: string[]; comment?: string }
): Promise<PublishResult> {
  if (!m.igUserId) {
    throw createError({ statusCode: 400, message: '還沒設定 Instagram 帳號。到「設定」頁按自動偵測。' })
  }
  if (!input.imagePaths.length) {
    throw createError({ statusCode: 400, message: 'Instagram 一定要有圖，這則貼文沒有選任何圖片' })
  }
  logInfo('meta', `發佈到 Instagram @${m.igUsername || m.igUserId}｜${input.imagePaths.length} 張圖`)

  const { urls, tempPhotoIds, notes } = await toPublicUrls(m, input.imagePaths)
  try {
    let containerId: string

    if (urls.length === 1) {
      const d = await graphPostParams(m, `${m.igUserId}/media`, {
        image_url: urls[0]!,
        caption: input.message
      })
      containerId = String(d.id || '')
    } else {
      // 多張要先各自建 is_carousel_item，再組一個 CAROUSEL
      const children: string[] = []
      for (const u of urls) {
        const c = await graphPostParams(m, `${m.igUserId}/media`, {
          image_url: u,
          is_carousel_item: 'true'
        })
        children.push(String(c.id || ''))
      }
      for (const c of children) await waitContainer(m, c, 'Instagram 輪播圖片')
      const d = await graphPostParams(m, `${m.igUserId}/media`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: input.message
      })
      containerId = String(d.id || '')
    }

    if (!containerId) throw createError({ statusCode: 502, message: 'Instagram 沒有回傳容器 id' })
    await waitContainer(m, containerId, 'Instagram 容器')

    const pub = await graphPostParams(m, `${m.igUserId}/media_publish`, { creation_id: containerId })
    const mediaId = String(pub.id || '')
    if (!mediaId) throw createError({ statusCode: 502, message: 'Instagram 發佈沒有回傳貼文 id' })

    let commentId = ''
    let commentSkipped = ''
    const text = input.comment?.trim()
    if (text) {
      try {
        const c = await graphPostParams(m, `${mediaId}/comments`, { message: text })
        commentId = String(c.id || '')
      } catch (e) {
        // IG 的留言連結本來就不可點，貼不上去不算大事
        commentSkipped = 'Instagram 留言沒貼成功：' + (e as Error).message
        logWarn('meta', commentSkipped)
      }
    }

    let permalink = `https://www.instagram.com/${m.igUsername || ''}`
    try {
      const info = await graphGet(m.graphVersion, mediaId, {
        access_token: m.pageToken,
        fields: 'permalink'
      })
      if (info.permalink) permalink = String(info.permalink)
    } catch {
      /* 拿不到就用帳號首頁 */
    }

    logOk('meta', `Instagram 發佈完成｜${mediaId}`)
    return { externalId: mediaId, permalink, photos: urls.length, commentId, commentSkipped, notes }
  } finally {
    await cleanupTempPhotos(m, tempPhotoIds)
  }
}

// ── Threads ───────────────────────────────────────────────────────

export const THREADS_MAX_CHARS = 500

export async function publishToThreads(
  m: MetaSettings,
  input: { message: string; imagePaths: string[] }
): Promise<PublishResult> {
  if (!m.threadsUserId || !m.threadsToken) {
    throw createError({ statusCode: 400, message: '還沒設定 Threads。到「設定」頁填 token 並測試連線。' })
  }
  const chars = [...input.message].length
  if (chars > THREADS_MAX_CHARS) {
    throw createError({
      statusCode: 400,
      message: `Threads 上限 ${THREADS_MAX_CHARS} 字，這個版本有 ${chars} 字。用 Threads 專用的版本，或先縮短。`
    })
  }
  logInfo('meta', `發佈到 Threads @${m.threadsUsername || m.threadsUserId}｜${input.imagePaths.length} 張圖`)

  const { urls, tempPhotoIds, notes } = await toPublicUrls(m, input.imagePaths)
  try {
    let containerId: string

    if (!urls.length) {
      const d = await threadsPost(m, `${m.threadsUserId}/threads`, {
        media_type: 'TEXT',
        text: input.message
      })
      containerId = String(d.id || '')
    } else if (urls.length === 1) {
      const d = await threadsPost(m, `${m.threadsUserId}/threads`, {
        media_type: 'IMAGE',
        image_url: urls[0]!,
        text: input.message
      })
      containerId = String(d.id || '')
    } else {
      const children: string[] = []
      for (const u of urls) {
        const c = await threadsPost(m, `${m.threadsUserId}/threads`, {
          media_type: 'IMAGE',
          image_url: u,
          is_carousel_item: 'true'
        })
        children.push(String(c.id || ''))
      }
      // 子項沒處理完就組輪播，父容器會跟著失敗
      for (const c of children) await waitThreadsContainer(m, c, 'Threads 輪播圖片')
      const d = await threadsPost(m, `${m.threadsUserId}/threads`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        text: input.message
      })
      containerId = String(d.id || '')
    }

    if (!containerId) throw createError({ statusCode: 502, message: 'Threads 沒有回傳容器 id' })
    await waitThreadsContainer(m, containerId, 'Threads 容器')

    let id = ''
    try {
      const pub = await threadsPost(m, `${m.threadsUserId}/threads_publish`, { creation_id: containerId })
      id = String(pub.id || '')
    } catch (e) {
      // 發佈失敗時容器多半還查得到狀態，一起講出來才知道是哪一步的問題
      let extra = ''
      try {
        const st = await threadsGet(containerId, {
          access_token: m.threadsToken,
          fields: 'status,error_message'
        })
        extra = `｜容器狀態 ${st.status}${st.error_message ? '：' + st.error_message : ''}`
      } catch {
        /* 查不到就算了 */
      }
      throw createError({
        statusCode: 502,
        message: ((e as { message?: string }).message || String(e)) + extra
      })
    }
    if (!id) throw createError({ statusCode: 502, message: 'Threads 發佈沒有回傳貼文 id' })

    let permalink = `https://www.threads.net/@${m.threadsUsername || ''}`
    try {
      const info = await threadsGet(id, { access_token: m.threadsToken, fields: 'permalink' })
      if (info.permalink) permalink = String(info.permalink)
    } catch {
      /* 拿不到就用帳號首頁 */
    }

    logOk('meta', `Threads 發佈完成｜${id}`)
    return { externalId: id, permalink, photos: urls.length, commentId: '', commentSkipped: '', notes }
  } finally {
    await cleanupTempPhotos(m, tempPhotoIds)
  }
}

async function threadsPost(m: MetaSettings, path: string, params: Record<string, string>) {
  const body = new URLSearchParams({ access_token: m.threadsToken, ...params })
  const t0 = Date.now()
  const res = await fetch(`${THREADS_GRAPH}/v1.0/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(120_000)
  })
  const text = await res.text()
  // 這裡以前沒有日誌，結果失敗一次之後完全查不到原因，只好靠猜
  const shown: Record<string, unknown> = { ...params }
  logInfo(
    'meta',
    `Threads POST ${path} → ${res.status}`,
    { params: shown, response: text.slice(0, 1500) },
    Date.now() - t0
  )

  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(text)
  } catch {
    throw createError({ statusCode: 502, message: 'Threads 回應不是 JSON：' + text.slice(0, 200) })
  }
  if (!res.ok) {
    const err = (d.error || {}) as { message?: string; error_user_msg?: string }
    throw createError({
      statusCode: res.status,
      message: `Threads API 錯誤（HTTP ${res.status}）：${err.error_user_msg || err.message || text.slice(0, 200)}`
    })
  }
  return d
}

/**
 * 等 Threads 容器處理完。
 *
 * 官方只說「建議平均等 30 秒」，但盲等 30 秒有兩個問題：本來 5 秒就好的也要等滿，
 * 而且真的還沒好的話照樣會失敗、還看不出原因。改成問 status ——
 * FINISHED 就走，ERROR 就把它的 error_message 講出來。
 */
async function waitThreadsContainer(m: MetaSettings, id: string, label: string) {
  const end = Date.now() + CONTAINER_TIMEOUT_MS
  let last = ''
  while (Date.now() < end) {
    const d = await threadsGet(id, {
      access_token: m.threadsToken,
      fields: 'id,status,error_message'
    })
    const st = String(d.status || '')
    last = st
    if (st === 'FINISHED') return
    if (st === 'ERROR' || st === 'EXPIRED') {
      throw createError({
        statusCode: 502,
        message: `${label} 處理失敗（${st}）：${String(d.error_message || '沒有給原因')}`
      })
    }
    await sleep(3000)
  }
  throw createError({ statusCode: 504, message: `${label} 等太久還沒處理完（最後狀態 ${last || '未知'}）` })
}
