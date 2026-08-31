/** 存 IG／Threads 的設定。token 傳 __clear__ 表示清掉 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    igUserId?: string
    threadsUserId?: string
    threadsToken?: string
  }>(event)

  const patch: Record<string, string> = {}
  if (typeof body?.igUserId === 'string') {
    patch.igUserId = body.igUserId.trim()
    if (!patch.igUserId) patch.igUsername = ''
  }
  if (typeof body?.threadsUserId === 'string') patch.threadsUserId = body.threadsUserId.trim()
  if (typeof body?.threadsToken === 'string' && body.threadsToken.trim()) {
    patch.threadsToken = body.threadsToken.trim() === '__clear__' ? '' : body.threadsToken.trim()
    if (!patch.threadsToken) patch.threadsUsername = ''
  }

  await saveMeta(patch)
  logInfo('meta', '已更新 IG／Threads 設定')
  return await $fetch('/api/meta/platforms')
})
