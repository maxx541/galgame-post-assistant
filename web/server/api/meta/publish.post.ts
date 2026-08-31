/**
 * 立即發佈一則貼文的某個版本。
 *
 * platform：facebook / instagram / threads
 * fbMode（只有 facebook 有用）：now 立即 / schedule 交給 Meta 排程
 *
 * 發佈是不可逆又對外的動作，所以 platform 與模式都不給預設值 —— 少帶就擋下來。
 * 以前 mode 預設 now，測試裡一支「應該被擋」的呼叫差點把稿子發到正式粉專。
 * 想排到未來時間走 /api/schedule，不要走這支。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    postId?: string
    variantId?: string
    platform?: PubPlatform
    fbMode?: 'now' | 'schedule'
    /** fbMode = schedule 時的發佈時間，毫秒 */
    scheduledAt?: number
    withComment?: boolean
    /** 舊欄位，還在用的話對應回 fbMode */
    mode?: string
  }>(event)

  const postId = safeSegment(body?.postId || '')
  const variantId = safeSegment(body?.variantId || '')

  const platform = body?.platform
  if (platform !== 'facebook' && platform !== 'instagram' && platform !== 'threads') {
    throw createError({ statusCode: 400, message: '要指定發佈平台（facebook／instagram／threads）' })
  }

  const fbMode = body?.fbMode || (body?.mode === 'schedule' ? 'schedule' : body?.mode === 'now' ? 'now' : undefined)
  if (platform === 'facebook' && fbMode !== 'now' && fbMode !== 'schedule') {
    throw createError({ statusCode: 400, message: '要指定 Facebook 的發佈模式（now／schedule）' })
  }
  if (fbMode === 'schedule') {
    const bad = validateSchedule('schedule', body?.scheduledAt)
    if (bad) throw createError({ statusCode: 400, message: bad })
  }

  const r = await publishOne({
    postId,
    variantId,
    platform,
    fbMode,
    scheduledAt: body?.scheduledAt,
    withComment: body?.withComment
  })

  const post = await loadPost(postId)
  const comment =
    body?.withComment === false
      ? ''
      : (post?.links || [])
          .filter(l => l.url.trim())
          .map(l => (l.label.trim() ? `${l.label.trim()}：${l.url.trim()}` : l.url.trim()))
          .join('\n')

  await recordPublish(postId, variantId, r, {
    scheduledAt: fbMode === 'schedule' && body?.scheduledAt ? new Date(body.scheduledAt).toISOString() : '',
    comment
  })

  return { ...r, postId: r.externalId, permalink: r.url, post: await loadPost(postId) }
})
