/** 補貼留言：草稿或排程的貼文上線後，把導流連結貼成留言 */
export default defineEventHandler(async event => {
  const body = await readBody<{ postId?: string; recordIndex?: number }>(event)
  const id = safeSegment(body?.postId || '')
  const idx = Number(body?.recordIndex)

  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const rec = post.publishRecords[idx]
  if (!rec) throw createError({ statusCode: 404, message: '找不到這筆發佈紀錄' })
  if (rec.commentDone) throw createError({ statusCode: 400, message: '這筆的留言已經貼過了' })
  if (!rec.externalId) throw createError({ statusCode: 400, message: '這筆沒有平台貼文 id' })
  if (!rec.comment?.trim()) throw createError({ statusCode: 400, message: '這筆沒有要貼的留言內容' })

  const m = await loadMeta()
  const commentId = await addComment(m, rec.externalId, rec.comment.trim())

  const { variants, ...meta } = post
  const r = meta.publishRecords[idx]
  if (r) {
    r.commentDone = true
    r.comment = ''
  }
  await savePostMeta(meta)
  logOk('meta', `補貼留言完成｜${rec.externalId}`)
  return { commentId, post: await loadPost(id) }
})
