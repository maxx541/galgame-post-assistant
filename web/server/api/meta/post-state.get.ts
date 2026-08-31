/** 查 Facebook 上那則貼文現在到底發出去了沒 */
export default defineEventHandler(async event => {
  const externalId = String(getQuery(event).externalId || '').trim()
  if (!externalId) throw createError({ statusCode: 400, message: '要給 Facebook 上的貼文 id' })
  return await postState(await loadMeta(), externalId)
})
