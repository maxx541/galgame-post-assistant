/**
 * 排一則到未來發佈。
 *
 * facebook 帶 useMeta=true 的話不進本機佇列，直接送 Meta 排程 ——
 * 那條路電腦關機照發，是 Facebook 才有的優勢。
 * instagram 與 threads 沒有這個選項（API 的排程鎖在白名單／根本沒有）。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    postId?: string
    variantId?: string
    platforms?: PubPlatform[]
    at?: string
    useMeta?: boolean
    withComment?: boolean
  }>(event)

  const postId = safeSegment(body?.postId || '')
  const variantId = safeSegment(body?.variantId || '')
  const at = String(body?.at || '')
  const platforms = (body?.platforms || []).filter(
    p => p === 'facebook' || p === 'instagram' || p === 'threads'
  )
  if (!platforms.length) throw createError({ statusCode: 400, message: '要選至少一個平台' })

  const bad = validateLocalSchedule(at)
  if (bad) throw createError({ statusCode: 400, message: bad })

  const post = await loadPost(postId)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const variant = post.variants.find(v => v.id === variantId)
  if (!variant) throw createError({ statusCode: 404, message: '找不到這個版本' })

  // 規範檢查只提醒不擋；平台的硬限制（字數、缺圖）才擋，
  // 因為那些等到時間到一定會失敗，不如現在就講
  const lintIssues = lintForPublish(variant.body)
  const imageCount = post.images.filter(i => i.selected).length
  for (const p of platforms) {
    const b = platformBlockers(p, variant.body, imageCount)
    if (b.length) throw createError({ statusCode: 400, message: b.join('；') })
  }

  const comment =
    body?.withComment === false
      ? ''
      : post.links
          .filter(l => l.url.trim())
          .map(l => (l.label.trim() ? `${l.label.trim()}：${l.url.trim()}` : l.url.trim()))
          .join('\n')

  const added: unknown[] = []
  const metaScheduled: unknown[] = []

  for (const platform of platforms) {
    if (platform === 'facebook' && body?.useMeta) {
      const ms = Date.parse(at)
      const bad2 = validateSchedule('schedule', ms)
      if (bad2) throw createError({ statusCode: 400, message: 'Facebook 交給 Meta 排程時：' + bad2 })
      const r = await publishOne({ postId, variantId, platform, fbMode: 'schedule', scheduledAt: ms, withComment: body?.withComment })
      await recordPublish(postId, variantId, r, { scheduledAt: new Date(ms).toISOString(), comment })
      metaScheduled.push(r)
      continue
    }
    added.push(await addSchedule({ postId, variantId, platform, at, comment }))
  }

  return { added, metaScheduled, lintIssues, post: await loadPost(postId) }
})
