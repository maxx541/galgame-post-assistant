/**
 * 抓一次。source: x（推特追蹤）/ notion（日報）/ both。
 *
 * 兩條線是分開的工作，各自有進度條、各自可以停止 ——
 * 想單獨更新日報不用陪著等一輪 X 抓取跑完。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ handles?: string[]; source?: string; force?: boolean }>(event).catch(
    () => ({}) as { handles?: string[]; source?: string; force?: boolean }
  )
  const raw = String(body?.source || 'x')
  const source = ['notion', 'web', 'both'].includes(raw) ? raw : 'x'

  if (source === 'notion') {
    const running = await activeJob('notion')
    if (running) return { jobId: running.id, kind: 'notion', alreadyRunning: true }
    const force = body?.force === true
    const job = startJob(
      'notion',
      force ? '重讀 Notion 日報（含已處理過的）' : '讀取 Notion 日報',
      ctx => runNotion(ctx, force),
      { total: 1 }
    )
    return { jobId: job.id, kind: 'notion' }
  }

  if (source === 'web') {
    const running = await activeJob('web')
    if (running) return { jobId: running.id, kind: 'web', alreadyRunning: true }
    const s2 = await loadDiscoverSettings()
    const n = s2.sites.filter(x => x.enabled && x.url).length
    const job = startJob('web', `抓取 ${n} 個網站`, ctx => runWeb(ctx), { total: n })
    return { jobId: job.id, kind: 'web' }
  }

  const running = await activeJob('discover')
  if (running) return { jobId: running.id, kind: 'discover', alreadyRunning: true }

  const s = await loadDiscoverSettings()
  const targets = s.sources.filter(
    x => x.enabled && x.handle && (!body?.handles?.length || body.handles.includes(x.handle))
  )
  const job =
    source === 'both'
      ? startJob('discover', `發掘（Notion＋${targets.length} 個帳號）`, ctx => runDiscover(body?.handles, ctx), {
          total: targets.length + 1
        })
      : startJob('discover', `抓取 ${targets.length} 個 X 帳號`, ctx => runX(body?.handles, ctx), {
          total: targets.length
        })
  return { jobId: job.id, kind: 'discover' }
})
