export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  return post
})
