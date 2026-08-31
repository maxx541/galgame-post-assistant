export default defineEventHandler(async event => {
  const id = safeSegment(getRouterParam(event, 'id') || '')
  const cur = await loadMaterial(id)
  if (!cur) throw createError({ statusCode: 404, message: '找不到這則素材' })
  const patch = await readBody<Record<string, unknown>>(event)
  delete patch.id
  delete patch.images
  delete patch.addedAt
  const next = { ...cur, ...patch, id } as typeof cur
  await saveMaterial(next)
  return next
})
