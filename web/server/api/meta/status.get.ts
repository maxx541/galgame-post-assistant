export default defineEventHandler(async event => {
  const m = await loadMeta()
  const deep = getQuery(event).deep === '1'
  const base = {
    connected: !!(m.pageId && m.pageToken),
    hasApp: !!(m.appId && m.appSecret),
    pageId: m.pageId,
    pageName: m.pageName,
    graphVersion: m.graphVersion,
    defaults: { graphVersion: DEFAULT_GRAPH_VERSION },
    requiredScopes: REQUIRED_SCOPES,
    tokenCheckedAt: m.tokenCheckedAt,
    token: null as null | Record<string, unknown>,
    appMode: null as null | Awaited<ReturnType<typeof checkAppMode>>
  }
  if (!deep || !base.connected) return base
  // 開發模式的 App 發出去的貼文別人看不到，而且從 API 完全看不出異常，
  // 所以一定要主動檢查並講出來
  // 把這個工具發過的貼文 id 找出來，拿去跟粉專其他貼文比互動
  const appPostIds: string[] = []
  try {
    for (const p of await listPosts()) {
      const full = await loadPost(p.id)
      for (const r of full?.publishRecords || []) {
        if (r.platform === 'facebook' && r.externalId) appPostIds.push(r.externalId)
      }
    }
  } catch {
    /* 讀不到就用空的，檢查會說「沒有東西可以比對」 */
  }
  base.appMode = await checkAppMode(m, appPostIds).catch(() => null)
  // 真的問一次 Meta：token 還有效嗎、權限齊不齊
  const t = await inspectToken(m.pageToken, m.appId, m.appSecret, m.graphVersion)
  await saveMeta({ tokenCheckedAt: new Date().toISOString() })
  return { ...base, token: { ...t, missing: missingScopes(t.scopes) } }
})
