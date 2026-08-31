export default defineEventHandler(async event => {
  const id = String(getRouterParam(event, 'id') || '')
  const rules = await loadRules()
  const next = rules.filter(r => r.id !== id)
  if (next.length === rules.length) throw createError({ statusCode: 404, message: '找不到這條規則' })
  await saveRules(next)
  return { rules: next }
})
