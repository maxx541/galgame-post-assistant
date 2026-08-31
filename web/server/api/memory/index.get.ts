export default defineEventHandler(async () => {
  const rules = await loadRules()
  const history = await loadHistory()
  return {
    rules,
    historyCount: history.length,
    lastAt: history[0]?.at || '',
    injected: buildMemoryBlock(rules, history)
  }
})
