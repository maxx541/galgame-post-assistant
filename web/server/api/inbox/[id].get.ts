export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const m = await loadMaterial(id)
  if (!m) throw createError({ statusCode: 404, message: '找不到這則素材' })
  return m
})
