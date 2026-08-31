/**
 * 把先前存成「未發佈貼文」的那則轉成公開，順便把留言補上。
 *
 * `/{page}/feed` 帶 published=false 產生的是未發佈貼文，不是 Business Suite 草稿，
 * 在後台任何清單裡都找不到。這支就是那些貼文唯一的出口。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ postId?: string; externalId?: string; withComment?: boolean }>(event)
  const id = safeSegment(body?.postId || '')
  const externalId = String(body?.externalId || '').trim()
  if (!externalId) throw createError({ statusCode: 400, message: '要給 Facebook 上的貼文 id' })

  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const rec = post.publishRecords.find(r => r.externalId === externalId)
  if (!rec) throw createError({ statusCode: 404, message: '這則貼文沒有這筆發佈紀錄' })

  const m = await loadMeta()
  const before = await postState(m, externalId)
  if (before.isPublished) {
    return { alreadyPublished: true, ...before, post }
  }

  await publishUnpublished(m, externalId)
  const after = await postState(m, externalId)

  let commentId = ''
  const comment = body?.withComment === false ? '' : rec.comment
  if (after.isPublished && comment?.trim() && !rec.commentDone) {
    try {
      commentId = await addComment(m, externalId, comment.trim())
    } catch (e) {
      logWarn('meta', '轉成公開了，但留言沒貼上：' + (e as Error).message)
    }
  }

  const { variants, ...meta } = post
  const target = meta.publishRecords.find(r => r.externalId === externalId)!
  target.mode = 'now'
  target.at = new Date().toISOString()
  if (commentId) {
    target.commentDone = true
    target.comment = ''
  }
  meta.status = 'published'
  await savePostMeta(meta)

  return { ...after, commentId, post: await loadPost(id) }
})
