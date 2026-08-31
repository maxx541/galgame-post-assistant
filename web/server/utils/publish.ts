import { join } from 'node:path'

/**
 * 發佈的分派層。立即發佈與本機排程都走這裡，邏輯只有一份。
 *
 * 三個平台的能力差很多，這裡把差異收在一個地方：
 *   facebook  API 原生支援排程（關機照發），也可以由本機在時間到時發
 *   instagram 只能本機排程（排程參數鎖在 Meta 白名單）；一定要有圖
 *   threads   只能本機排程；上限 500 字
 */

export type PubPlatform = 'facebook' | 'instagram' | 'threads'

/**
 * Threads 的字數上限。igthreads.ts 也有一份 —— 這裡刻意不 import 它，
 * 因為那個檔靠 Nitro auto-import，一 import 進來這裡的純函式就沒辦法被
 * npm test 直接載入（這個專案踩過好幾次）。兩邊都改的話記得一起改。
 */
const THREADS_MAX_CHARS = 500

/** 只擋第〇節那四條硬規定，提醒與建議不擋 */
export function lintForPublish(text: string): string[] {
  const out: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim())
  if (!/^【[^】]+】.+/.test(lines[0] || '')) out.push('首行要有【體裁】加標題')
  if (/(\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])/u.test(text.replace(/[♪♫♬™©®〜～]/g, ''))) {
    out.push('全文不得出現 emoji')
  }
  if (!/（來源[：]|（主辦[：]/.test(text)) out.push('缺少（來源：XXX）')
  if (/https?:\/\//.test(text)) out.push('正文不可出現網址，要改寫「網址放留言」')
  return out
}

/** 平台各自的硬限制，發出去之前先擋 */
export function platformBlockers(
  platform: PubPlatform,
  text: string,
  imageCount: number
): string[] {
  const out: string[] = []
  const chars = [...text].length
  if (platform === 'threads' && chars > THREADS_MAX_CHARS) {
    out.push(`Threads 上限 ${THREADS_MAX_CHARS} 字，這個版本 ${chars} 字`)
  }
  if (platform === 'instagram') {
    if (!imageCount) out.push('Instagram 一定要有圖，這則沒有選任何圖片')
    if (chars > 2200) out.push(`Instagram 文案上限 2200 字，這個版本 ${chars} 字`)
  }
  return out
}

export interface PublishOneInput {
  postId: string
  variantId: string
  platform: PubPlatform
  /** facebook 專用：now 立即 / schedule 交給 Meta 排程 */
  fbMode?: 'now' | 'schedule'
  /** fbMode = schedule 時的時間（毫秒） */
  scheduledAt?: number
  withComment?: boolean
}

/**
 * 發一則。回傳的東西會直接寫進 post.publishRecords。
 * 這支不處理「什麼時候發」——排程由呼叫端決定，它只管現在就發出去。
 */
export async function publishOne(input: PublishOneInput) {
  const post = await loadPost(input.postId)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const variant = post.variants.find(v => v.id === input.variantId)
  if (!variant) throw createError({ statusCode: 404, message: '找不到這個版本' })
  if (!variant.body.trim()) throw createError({ statusCode: 400, message: '這個版本沒有內容' })

  // 規範檢查只提醒，不擋 —— 總會有特例（轉貼原文、合作稿、平台限制），
  // 工具沒立場替使用者決定那是不是錯。真正會讓 API 直接失敗的（字數、缺圖）
  // 才擋，那是擋了才不會白白送出去。
  const lintIssues = lintForPublish(variant.body)

  const imagePaths = post.images
    .filter(i => i.selected)
    .map(i => join(postsDir(), input.postId, 'images', i.file))

  const blockers = platformBlockers(input.platform, variant.body, imagePaths.length)
  if (blockers.length) throw createError({ statusCode: 400, message: blockers.join('；') })

  const comment =
    input.withComment === false
      ? ''
      : post.links
          .filter(l => l.url.trim())
          .map(l => (l.label.trim() ? `${l.label.trim()}：${l.url.trim()}` : l.url.trim()))
          .join('\n')

  const m = await loadMeta()

  if (input.platform === 'facebook') {
    const mode: PublishMode = input.fbMode === 'schedule' ? 'schedule' : 'now'
    const r = await publishToPage(m, {
      message: variant.body,
      imagePaths,
      mode,
      scheduledAt: input.scheduledAt,
      comment
    })
    return {
      platform: 'facebook' as const,
      externalId: r.postId,
      url: r.permalink,
      commentId: r.commentId,
      commentSkipped: r.commentSkipped,
      photos: r.photos,
      notes: [] as string[],
      lintIssues,
      mode
    }
  }

  const r =
    input.platform === 'instagram'
      ? await publishToInstagram(m, { message: variant.body, imagePaths, comment })
      : await publishToThreads(m, { message: variant.body, imagePaths })

  return {
    platform: input.platform,
    externalId: r.externalId,
    url: r.permalink,
    commentId: r.commentId,
    commentSkipped:
      r.commentSkipped ||
      (input.platform === 'threads' && comment ? 'Threads 沒有留言 API，導流連結要自己補' : ''),
    photos: r.photos,
    notes: r.notes,
    lintIssues,
    mode: 'now' as const
  }
}

/** 把發佈結果寫進貼文的紀錄裡 */
export async function recordPublish(
  postId: string,
  variantId: string,
  r: Awaited<ReturnType<typeof publishOne>>,
  extra: { scheduledAt?: string; comment?: string } = {}
) {
  const post = await loadPost(postId)
  if (!post) return
  const { variants, ...meta } = post
  void variants
  meta.publishRecords.push({
    platform: r.platform,
    at: new Date().toISOString(),
    url: r.url,
    mode: r.mode,
    externalId: r.externalId,
    variantId,
    scheduledAt: extra.scheduledAt || '',
    comment: r.commentId ? '' : extra.comment || '',
    commentDone: !!r.commentId
  })
  if (r.mode === 'now') meta.status = 'published'
  await savePostMeta(meta)
}
