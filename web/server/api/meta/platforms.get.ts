/** IG／Threads 的連接狀態。token 本身不回傳 */
export default defineEventHandler(async () => {
  const m = await loadMeta()
  return {
    fbConnected: !!(m.pageId && m.pageToken),
    instagram: {
      userId: m.igUserId,
      username: m.igUsername,
      connected: !!m.igUserId
    },
    threads: {
      userId: m.threadsUserId,
      username: m.threadsUsername,
      hasToken: !!m.threadsToken,
      connected: !!(m.threadsUserId && m.threadsToken)
    },
    igScopes: IG_SCOPES
  }
})
