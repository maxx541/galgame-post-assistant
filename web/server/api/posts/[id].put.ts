export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const current = await loadPost(id)
  if (!current) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const patch = await readBody<Record<string, unknown>>(event)
  delete patch.id
  delete patch.variants
  delete patch.createdAt
  const { variants, ...meta } = current
  const next = { ...meta, ...patch, id }
  await savePostMeta(next as typeof meta)
  return await loadPost(id)
})
