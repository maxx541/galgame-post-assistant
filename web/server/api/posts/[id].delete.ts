export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const bytes = await deletePost(id)
  if (bytes < 0) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  logOk('post', `刪除貼文 ${id}`)
  return { ok: true }
})
