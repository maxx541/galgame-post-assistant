/** 清空記憶庫。keepHistory=true 時只清規則，保留修訂歷史 */
export default defineEventHandler(async event => {
  const body = await readBody<{ keepHistory?: boolean }>(event)
  await saveRules([])
  if (!body?.keepHistory) await saveHistory([])
  return { ok: true }
})
