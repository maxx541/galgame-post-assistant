export default defineEventHandler(async () => {
  const s = await loadDiscoverSettings()
  const candidates = await loadCandidates()
  const runs = await loadRunLog()
  return {
    settings: s,
    counts: {
      pending: candidates.filter(c => c.status === 'pending').length,
      accepted: candidates.filter(c => c.status === 'accepted').length,
      ignored: candidates.filter(c => c.status === 'ignored').length,
      total: candidates.length
    },
    lastRun: runs[0] || null,
    defaults: defaultSettings()
  }
})
